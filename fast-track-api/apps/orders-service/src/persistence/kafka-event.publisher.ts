import { Injectable, Logger } from '@nestjs/common';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type {
  EventEnvelope,
  EventPublisher,
} from '../application/outbox-port.js';

@Injectable()
export class KafkaEventPublisher implements EventPublisher {
  private readonly logger = new Logger(KafkaEventPublisher.name);
  private producer?: Producer;
  private connecting?: Promise<void>;
  private connected = false;

  async publish(
    topic: string,
    key: string,
    event: EventEnvelope,
    headers: Record<string, string>,
  ): Promise<void> {
    const producer = this.getProducer();
    await this.connect(producer);
    await producer.send({
      topic,
      acks: -1,
      messages: [
        {
          key,
          value: JSON.stringify(event),
          headers: Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
              name,
              Buffer.from(value),
            ]),
          ),
        },
      ],
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer && this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }

  private getProducer(): Producer {
    if (this.producer) {
      return this.producer;
    }
    const brokers = (process.env.KAFKA_BROKERS ?? '')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    if (brokers.length === 0) {
      throw new Error('KAFKA_BROKERS is not configured.');
    }
    const kafka = new Kafka({
      clientId: 'orders-service',
      brokers,
      logLevel: logLevel.ERROR,
    });
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    this.logger.log(`Kafka producer configured for ${brokers.length} broker(s).`);
    return this.producer;
  }

  private async connect(producer: Producer): Promise<void> {
    if (this.connected) {
      return;
    }
    if (!this.connecting) {
      this.connecting = producer.connect().then(() => {
        this.connected = true;
      }).finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }
}
