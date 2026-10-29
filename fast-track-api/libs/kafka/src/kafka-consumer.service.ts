/**
 * KafkaConsumerService: subscribes a service to a topic and runs its handler.
 *
 * Why it exists
 * -------------
 * Consuming correctly involves several rules that every service must follow
 * the same way (spec 5.2, ADR-009, ADR-012). This service applies them once:
 *
 * - Offsets are committed manually, only AFTER the handler finished
 *   (at-least-once delivery).
 * - Failures are retried in-process and then sent to `<topic>.dlq`
 *   (see MessageProcessor).
 * - One message at a time per partition, several partitions in parallel
 *   (ordering per key).
 *
 * Key Kafka concepts used here
 * ----------------------------
 * Offset: the position of a message inside a partition (0, 1, 2, ...).
 * "Committing" an offset means telling Kafka "this consumer group has handled
 * everything before this position". After a restart or a rebalance, the group
 * resumes from the last committed offset.
 *
 * Consumer group: a set of consumers that share the work of reading a topic.
 * Kafka assigns each partition to exactly ONE consumer of the group, so every
 * message is processed by one instance only. If `gps.batches` has 24
 * partitions and we run 3 instances of gps-tracking-worker with the same
 * groupId, each instance gets about 8 partitions; if one instance dies, its
 * partitions are reassigned to the others ("rebalance"). Different services
 * use different groupIds, so each service receives its own copy of every
 * message. That is why the groupId is the service name.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Topic } from '@libs/events';
import { KAFKA_CLIENT, KAFKA_OPTIONS } from './kafka.constants.js';
import type { ResolvedKafkaOptions } from './kafka.options.js';
import { KafkaProducerService } from './kafka-producer.service.js';
import { MessageProcessor, type EventHandler } from './message-processor.js';

/** Options of {@link KafkaConsumerService.subscribe}. */
export interface SubscribeOptions<TPayload = unknown> {
  /** Topic to read, one of the `Topics` constants. */
  topic: Topic;
  /**
   * Consumer group id. Use the service name (the default, taken from
   * `KafkaModule.forRoot({ clientId })`). Only pass a different value if one
   * service needs two independent subscriptions to the same topic.
   */
  groupId?: string;
  /** Business logic for each event. Must be idempotent (ADR-009). */
  handler: EventHandler<TPayload>;
}

@Injectable()
export class KafkaConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly consumers: KafkaJS.Consumer[] = [];

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: KafkaJS.Kafka,
    @Inject(KAFKA_OPTIONS) private readonly options: ResolvedKafkaOptions,
    private readonly producer: KafkaProducerService,
  ) {}

  /**
   * Starts consuming `topic` and calls `handler` for every event.
   *
   * Call it from `onApplicationBootstrap()` of a provider: by then every
   * module has run `onModuleInit()`, so the producer (needed for the DLQ) is
   * already connected. The returned promise resolves once the consumer is
   * running; messages are then processed in the background.
   *
   * @example
   * await this.consumer.subscribe({
   *   topic: Topics.GPS_BATCHES,
   *   handler: async (envelope) => { ... },
   * });
   */
  async subscribe<TPayload = unknown>(subscription: SubscribeOptions<TPayload>): Promise<void> {
    const { topic, handler } = subscription;
    const groupId = subscription.groupId ?? this.options.clientId;

    const consumer = this.kafka.consumer({
      kafkaJS: {
        groupId,
        // Auto-commit OFF: by default the client commits offsets every few
        // seconds in the background, whether or not our handler has finished.
        // If the process crashed after such a commit but before the handler
        // ended, that message would be skipped forever (at-most-once). We
        // commit ourselves, after processing (spec 5.2, ADR-009).
        autoCommit: false,
        // When the group has no committed offset yet (first deploy), start at
        // the oldest retained message instead of only new ones, so events
        // published before the consumer first started are not missed.
        fromBeginning: true,
      },
    });
    this.consumers.push(consumer);

    const processor = new MessageProcessor<TPayload>({
      groupId,
      handler,
      sendToDlq: (dlq, message) => this.producer.send(dlq, message),
      logger: this.logger,
    });

    await consumer.connect();
    await consumer.subscribe({ topics: [topic] });

    await consumer.run({
      // Concurrency model: `eachMessage` is never called for the next message
      // of a partition until the previous call has finished. So inside one
      // partition, messages are handled strictly one by one, in offset order.
      // Since every event with the same key goes to the same partition, all
      // events of one driver (or one order) are processed in the order they
      // were published (ADR-001). Different partitions hold different keys,
      // whose relative order does not matter, so up to N of them can be
      // processed in parallel to use the machine better.
      partitionsConsumedConcurrently: this.options.partitionsConsumedConcurrently,

      eachMessage: async ({ topic: source, partition, message }) => {
        // Handle (with retries, or dead-letter). Throws only if the DLQ write
        // failed; then we skip the commit and the client redelivers the same
        // message, so nothing is lost.
        await processor.process({
          topic: source,
          partition,
          offset: message.offset,
          key: message.key,
          value: message.value,
          headers: message.headers ?? {},
        });

        // Commit AFTER processing => at-least-once delivery: if we crash
        // between the handler and this line, the message is delivered again on
        // restart. It may be processed twice but is never lost, which is why
        // every consumer must be idempotent (ADR-009: processed_events table,
        // sequence or version guards...).
        //
        // By Kafka convention the committed offset is the NEXT offset to read,
        // hence `offset + 1`. BigInt because offsets are 64-bit integers.
        //
        // Committing per message costs one round trip each; it is the simplest
        // correct option. Batching commits is a possible later optimisation.
        await consumer.commitOffsets([
          { topic: source, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });

    this.logger.log(`Consumer subscribed (topic=${topic}, groupId=${groupId})`);
  }

  /**
   * Disconnects every consumer when the application shuts down.
   *
   * A clean disconnect makes the consumer leave its group right away, so Kafka
   * reassigns its partitions to the remaining instances immediately. Without
   * it, the broker waits for the session timeout (tens of seconds) before
   * noticing the consumer is gone, and those partitions sit unprocessed.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.disconnect()));
    if (this.consumers.length > 0) {
      this.logger.log(`Disconnected ${this.consumers.length} consumer(s)`);
    }
  }
}
