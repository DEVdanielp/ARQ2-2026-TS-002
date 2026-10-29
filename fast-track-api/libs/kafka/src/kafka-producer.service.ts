/**
 * KafkaProducerService: the single Kafka producer of a service.
 *
 * Why it exists
 * -------------
 * It is the only place where a service writes to Kafka. It enforces the
 * message format of spec 5.1 (JSON envelope as value, mandatory key, headers
 * `eventType` and `correlationId`) and the delivery settings of spec 5.2
 * (`acks=all`, idempotent producer), so no service can get them wrong.
 *
 * It also owns the lifecycle of the producer connection: it connects when the
 * Nest application starts and disconnects cleanly when it stops.
 *
 * Designed for the outbox (ADR-005)
 * ---------------------------------
 * `publish()` receives an envelope that was ALREADY created, instead of
 * creating one itself. The future outbox relay will store the envelope in the
 * `outbox` table inside the business transaction and later call `publish()`
 * with exactly that envelope, so a re-sent event keeps its original `eventId`
 * and consumers can deduplicate it (ADR-009). `publish()` also throws when the
 * broker does not confirm the write, so the relay knows the row is not sent.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { EventEnvelope, Topic } from '@libs/events';
import { KAFKA_CLIENT, KAFKA_OPTIONS } from './kafka.constants.js';
import { KafkaHeaders, type KafkaHeaderMap } from './kafka-headers.js';
import type { ResolvedKafkaOptions } from './kafka.options.js';

/** A message ready to be written as-is: used to forward messages to a DLQ. */
export interface RawKafkaMessage {
  key: Buffer | string | null;
  value: Buffer | string | null;
  headers?: KafkaHeaderMap;
}

/** Where the broker stored a published message. */
export interface PublishResult {
  partition: number;
  /** Present only when the client reports it. */
  offset?: string;
}

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: KafkaJS.Producer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: KafkaJS.Kafka,
    @Inject(KAFKA_OPTIONS) private readonly options: ResolvedKafkaOptions,
  ) {
    this.producer = kafka.producer({
      kafkaJS: {
        // acks = all (-1): the broker confirms a write only after the message
        // is stored by the leader AND every in-sync replica. If the leader
        // crashes right after confirming, a replica already has the message,
        // so an acknowledged event is never lost (spec 5.2, at-least-once).
        // With acks=1 the leader could confirm and die before replicating.
        // (Locally we run one broker, so "all" is just that broker, but the
        // code is already correct for a real multi-broker cluster.)
        acks: -1,
        // Idempotent producer: the broker tags each message with a producer
        // id and a sequence number per partition. When the producer retries a
        // send because an acknowledgement got lost on the network, the broker
        // recognises the sequence number and drops the duplicate. It also
        // keeps retried messages in their original order within a partition.
        // Without it, a network blip could write the same event twice or
        // swap the order of two events of the same key (spec 5.2, ADR-001).
        // Note: it only prevents duplicates caused by producer retries; an
        // application that calls publish() twice still publishes twice, which
        // is why consumers must be idempotent anyway (ADR-009).
        idempotent: true,
        // Topics are created explicitly by deploy/kafka/create-topics.sh.
        allowAutoTopicCreation: false,
      },
    });
  }

  /**
   * Connects the producer when the module starts.
   *
   * If Kafka is unreachable, `connect()` retries a few times and then throws,
   * which makes the application fail to start. That is intended: a service
   * that cannot publish events should not report itself as healthy. Docker
   * restarts it (`restart: unless-stopped`) until Kafka is available.
   */
  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log(
      `Producer connected (clientId=${this.options.clientId}, brokers=${this.options.brokers.join(',')})`,
    );
  }

  /**
   * Disconnects the producer when the application shuts down.
   *
   * Why a clean disconnect matters: the producer keeps messages in an
   * in-memory buffer and sends them in batches. `disconnect()` flushes that
   * buffer and waits for the broker's acknowledgements, so events accepted by
   * `publish()` are not lost when the process stops. It also closes the TCP
   * connections, so the broker frees their resources immediately instead of
   * waiting for a timeout.
   *
   * Nest only runs this hook on SIGTERM/SIGINT if `main.ts` calls
   * `app.enableShutdownHooks()`.
   */
  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Producer disconnected');
  }

  /**
   * Publishes an event to a topic and waits until the broker confirms it.
   *
   * @param topic - one of the `Topics` constants from `@libs/events`.
   * @param key - partition key (e.g. `driverId` for `gps.batches`, `orderId`
   *   for order topics; see spec 5.1). REQUIRED: Kafka hashes the key to pick
   *   the partition, so all events with the same key land in the same
   *   partition and are read in the order they were written. Without a key,
   *   events of one driver or order would be spread over several partitions
   *   and could be processed out of order, which is exactly the bug ADR-001
   *   fixes.
   * @param envelope - the event, created with `createEnvelope()`. Serialized to
   *   JSON as the message value.
   * @returns the partition and offset where the event was stored.
   * @throws if the key is empty or the broker does not acknowledge the write.
   */
  async publish<TPayload>(
    topic: Topic,
    key: string,
    envelope: EventEnvelope<TPayload>,
  ): Promise<PublishResult> {
    if (!key) {
      throw new Error(
        `Refusing to publish ${envelope.eventType} to ${topic} without a key: ordering is per key (ADR-001)`,
      );
    }

    const logContext = {
      topic,
      key,
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
    };

    try {
      const result = await this.send(topic, {
        key,
        value: JSON.stringify(envelope),
        headers: {
          [KafkaHeaders.EVENT_TYPE]: envelope.eventType,
          [KafkaHeaders.CORRELATION_ID]: envelope.correlationId,
        },
      });
      this.logger.log({ msg: 'Event published', ...logContext, ...result });
      return result;
    } catch (error) {
      this.logger.error({ msg: 'Failed to publish event', ...logContext, error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Writes a message exactly as given (key, value and headers untouched).
   *
   * Used by the consumer to forward a failed message to its DLQ without
   * altering the original bytes (even if they are not valid JSON). Normal
   * business code should use {@link publish} instead.
   *
   * @param topic - destination topic, e.g. `dlqTopic(Topics.GPS_BATCHES)`.
   */
  async send(topic: string, message: RawKafkaMessage): Promise<PublishResult> {
    const [metadata] = await this.producer.send({ topic, messages: [message] });
    // The client does not always report the offset; omit it rather than log `undefined`.
    return metadata.offset === undefined
      ? { partition: metadata.partition }
      : { partition: metadata.partition, offset: metadata.offset };
  }
}
