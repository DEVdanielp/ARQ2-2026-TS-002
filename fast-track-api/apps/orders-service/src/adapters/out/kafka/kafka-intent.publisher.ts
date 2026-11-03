/**
 * Publishes intents to `orders.intents`, keyed by orderId, so the intents of
 * one order are applied one at a time (ADR-006). `publish()` waits for acks=all;
 * a failure becomes the `503` of spec 4.2.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaProducerService } from '@libs/kafka';
import { ServiceUnavailableError } from '../../../application/errors.js';
import { IntentPublisher } from '../../../application/ports.js';

@Injectable()
export class KafkaIntentPublisher extends IntentPublisher {
  private readonly logger = new Logger(KafkaIntentPublisher.name);

  constructor(private readonly producer: KafkaProducerService) {
    super();
  }

  async publish(orderId: string, envelope: EventEnvelope): Promise<void> {
    try {
      await this.producer.publish(Topics.ORDERS_INTENTS, orderId, envelope);
    } catch (error) {
      this.logger.error({
        msg: 'Intent not queued',
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError('Kafka');
    }
  }
}
