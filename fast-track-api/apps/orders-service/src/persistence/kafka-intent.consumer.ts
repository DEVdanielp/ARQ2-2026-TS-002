import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  Kafka,
  logLevel,
  type Consumer,
  type EachMessagePayload,
} from 'kafkajs';
import { randomUUID } from 'node:crypto';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
} from '../application/outbox-port.js';
import {
  INTENT_PROCESSOR,
  type IntentProcessor,
} from '../application/intent-processor.port.js';

const RETRY_DELAYS_MS = [200, 1_000, 5_000];
const CONSUMER_NAME = 'orders-state-engine';
const TOPIC = 'orders.intents';
const RECONNECT_DELAY_MS = 5_000;

@Injectable()
export class KafkaIntentConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaIntentConsumer.name);
  private consumer?: Consumer;
  private kafka?: Kafka;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;

  constructor(
    @Inject(INTENT_PROCESSOR)
    private readonly processor: IntentProcessor,
    @Inject(EVENT_PUBLISHER)
    private readonly publisher: EventPublisher,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!process.env.ORDERS_DATABASE_URL || !process.env.KAFKA_BROKERS) {
      this.logger.error(
        'Intent consumer is not running: ORDERS_DATABASE_URL and KAFKA_BROKERS must be configured.',
      );
      return;
    }
    const brokers = process.env.KAFKA_BROKERS.split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    if (brokers.length === 0) {
      this.logger.error('Intent consumer is not running: KAFKA_BROKERS is empty.');
      return;
    }

    this.kafka = new Kafka({
      clientId: 'orders-service',
      brokers,
      logLevel: logLevel.ERROR,
    });
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.consumer) {
      await this.consumer.stop().catch((error: unknown) => {
        this.logger.warn(
          `Could not stop Kafka intent consumer: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await this.consumer.disconnect().catch((error: unknown) => {
        this.logger.warn(
          `Could not disconnect Kafka intent consumer: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    if (!this.consumer || this.stopping) {
      throw new Error('Intent consumer is not ready.');
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.processor.process(
          message.value,
          topic,
          partition,
          message.offset,
        );
        await this.commit(topic, partition, message.offset);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt], () => payload.heartbeat());
        }
      }
    }

    await this.publishToDlq(topic, partition, message, lastError);
    await this.commit(topic, partition, message.offset);
    this.logger.error(
      `Message ${topic}[${partition}]@${message.offset} exhausted retries and was sent to ${topic}.dlq.`,
      lastError instanceof Error ? lastError.stack : String(lastError),
    );
  }

  private async commit(
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    if (!this.consumer) {
      throw new Error('Intent consumer disconnected before offset commit.');
    }
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(offset) + 1n).toString() },
    ]);
  }

  private async connect(): Promise<void> {
    if (this.stopping || !this.kafka) {
      return;
    }
    const consumer = this.kafka.consumer({ groupId: CONSUMER_NAME });
    this.consumer = consumer;
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
      await consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handleMessage(payload),
      });
      this.logger.log(`Subscribed to ${TOPIC} as ${CONSUMER_NAME}.`);
    } catch (error) {
      this.logger.error(
        `Could not start Kafka intent consumer; retrying in ${RECONNECT_DELAY_MS} ms.`,
        error instanceof Error ? error.stack : String(error),
      );
      await consumer.disconnect().catch((disconnectError: unknown) => {
        this.logger.warn(
          `Could not disconnect failed Kafka intent consumer: ${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}`,
        );
      });
      if (this.consumer === consumer) {
        this.consumer = undefined;
      }
      if (!this.stopping) {
        this.reconnectTimer = setTimeout(() => {
          void this.connect();
        }, RECONNECT_DELAY_MS);
        this.reconnectTimer.unref();
      }
    }
  }

  private async publishToDlq(
    topic: string,
    partition: number,
    message: EachMessagePayload['message'],
    error: unknown,
  ): Promise<void> {
    const correlationHeader = message.headers?.correlationId;
    const headerValue = Array.isArray(correlationHeader)
      ? correlationHeader[0]
      : correlationHeader;
    const correlationId =
      typeof headerValue === 'string'
        ? headerValue
        : headerValue?.toString('utf8');
    let originalPayload: unknown = message.value?.toString('utf8') ?? null;
    try {
      originalPayload = originalPayload
        ? JSON.parse(originalPayload as string)
        : null;
    } catch {
      this.logger.warn(
        `Could not parse ${topic}[${partition}]@${message.offset} before sending it to the DLQ.`,
      );
    }
    const event = {
      eventId: randomUUID(),
      eventType: 'DeadLetteredEvent',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'orders-service',
      correlationId:
        correlationId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          correlationId,
        )
          ? correlationId
          : randomUUID(),
      aggregateId:
        message.key?.toString('utf8') &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          message.key.toString('utf8'),
        )
          ? message.key.toString('utf8')
          : randomUUID(),
      aggregateVersion: null,
      payload: {
        sourceTopic: topic,
        sourcePartition: partition,
        sourceOffset: message.offset,
        originalEvent: originalPayload,
        error: error instanceof Error ? error.message : String(error),
      },
    };
    await this.publisher.publish(
      `${topic}.dlq`,
      message.key?.toString('utf8') ?? event.aggregateId,
      event,
      {
        eventType: event.eventType,
        correlationId: event.correlationId,
        sourceTopic: topic,
      },
    );
  }
}

async function delay(
  durationMs: number,
  heartbeat: () => Promise<void>,
): Promise<void> {
  const intervalMs = 100;
  for (let waited = 0; waited < durationMs; waited += intervalMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, durationMs - waited)),
    );
    await heartbeat();
  }
}
