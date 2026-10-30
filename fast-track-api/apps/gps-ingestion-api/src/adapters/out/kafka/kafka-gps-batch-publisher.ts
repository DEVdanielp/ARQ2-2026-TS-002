/**
 * GpsBatchPublisher over Kafka: writes `GpsBatchReceived` to `gps.batches`
 * with key = driverId (spec 5.1, ADR-001).
 *
 * Why it publishes directly and not through the outbox (ADR-005): the outbox
 * protects "database change + event" pairs. This service has no database
 * (spec 1: stateless), so the event IS the whole effect, and the HTTP response
 * tells the app whether it happened: 202 = Kafka confirmed it (acks=all,
 * idempotent producer, from @libs/kafka), 503 = it did not, retry.
 *
 * Why a timeout: if the broker is down, the Kafka client keeps the message in
 * its buffer and keeps retrying for minutes. Holding the HTTP request that long
 * helps nobody, so after `timeoutMs` we answer 503. The buffered message may
 * still be delivered later; the app's retry then duplicates those points, and
 * the worker drops them by sequence (ADR-009).
 */
import { Injectable } from '@nestjs/common';
import { Topics, type EventEnvelope, type GpsBatchReceivedPayload } from '@libs/events';
import { KafkaProducerService } from '@libs/kafka';
import { EventBusUnavailableError, GpsBatchPublisher } from '../../../application/ports.js';

/** Settings of the publisher, read from the environment. */
export class PublisherSettings {
  constructor(
    /** Longest wait for Kafka's acknowledgement before answering 503. */
    readonly timeoutMs: number,
  ) {}
}

@Injectable()
export class KafkaGpsBatchPublisher extends GpsBatchPublisher {
  constructor(
    private readonly producer: KafkaProducerService,
    private readonly settings: PublisherSettings,
  ) {
    super();
  }

  async publish(envelope: EventEnvelope<GpsBatchReceivedPayload>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no acknowledgement after ${this.settings.timeoutMs} ms`)),
        this.settings.timeoutMs,
      );
    });

    try {
      // Key = driverId: same driver -> same partition -> processed in order.
      await Promise.race([this.producer.publish(Topics.GPS_BATCHES, envelope.payload.driverId, envelope), timeout]);
    } catch (error) {
      throw new EventBusUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
