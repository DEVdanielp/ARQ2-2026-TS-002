import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  EVENT_PUBLISHER,
  OUTBOX_REPOSITORY,
  type EventPublisher,
  type OutboxEvent,
  type OutboxRepository,
} from './outbox-port.js';

const POLL_INTERVAL_MS = 200;
const BATCH_SIZE = 20;

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  onModuleInit(): void {
    if (!process.env.ORDERS_DATABASE_URL || !process.env.KAFKA_BROKERS) {
      this.logger.error(
        'Outbox relay is not running: ORDERS_DATABASE_URL and KAFKA_BROKERS must be configured.',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const leaseOwner = randomUUID();
      const events = await this.outbox.claimPending(BATCH_SIZE, leaseOwner);
      for (const event of events) {
        await this.publishOne(event, leaseOwner);
      }
    } catch (error) {
      this.logger.error(
        'Failed to process pending orders outbox events',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.polling = false;
    }
  }

  private async publishOne(
    event: OutboxEvent,
    leaseOwner: string,
  ): Promise<void> {
    try {
      await this.publisher.publish(
        event.topic,
        event.aggregateId,
        {
          eventId: event.eventId,
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          occurredAt: event.occurredAt.toISOString(),
          producer: event.producer,
          correlationId: event.correlationId,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          payload: event.payload,
        },
        {
          ...event.headers,
          eventType: event.eventType,
          correlationId: event.correlationId,
        },
      );
      await this.outbox.markPublished(event.eventId, leaseOwner);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Unknown Kafka publish error';
      this.logger.warn(
        `Could not publish outbox event ${event.eventId} (${event.eventType}); it will be retried: ${detail}`,
      );
      await this.outbox.markFailed(event.eventId, leaseOwner, detail);
    }
  }
}
