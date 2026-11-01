/**
 * Kafka inbound adapter: consumes `orders.events` and routes each event to
 * its use case (consumer group `profiles-service`).
 *
 * | Event          | Use case                         | Effect                                   |
 * | -------------- | -------------------------------- | ---------------------------------------- |
 * | OrderCreated   | StartAssignment                  | register the order, try to assign now    |
 * | OrderOnTheWay  | TrackOrderStatus (ON_THE_WAY)    | the driver can no longer go OFFLINE      |
 * | OrderDelivered | TrackOrderStatus (DELIVERED)     | release the slot (F1-S5)                 |
 * | OrderCancelled | TrackOrderStatus (CANCELLED)     | release the slot, stop retries (saga)    |
 *
 * All events of one order share the topic and the key (orderId), so they
 * arrive in order; the use cases still guard by eventId and aggregateVersion
 * (ADR-009). Profiles publishes `assignment.events` but does not consume it.
 *
 * Error policy (from @libs/kafka): a handler that throws is retried in
 * process (200 ms, 1 s, 5 s) and then sent to `orders.events.dlq`.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';
import type { OrderStatus } from '../../../domain/profiles.js';
import {
  StartAssignment,
  TrackOrderStatus,
} from '../../../application/assignment.use-cases.js';
import { parseOrderCreated, parseOrderStatusEvent } from './event-payloads.js';

const STATUS_BY_EVENT: Record<string, Exclude<OrderStatus, 'CREATED'>> = {
  OrderOnTheWay: 'ON_THE_WAY',
  OrderDelivered: 'DELIVERED',
  OrderCancelled: 'CANCELLED',
};

@Injectable()
export class OrderEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderEventsConsumer.name);

  constructor(
    private readonly kafka: KafkaConsumerService,
    private readonly startAssignment: StartAssignment,
    private readonly trackOrderStatus: TrackOrderStatus,
  ) {}

  /** Runs after every module is initialised (producer and outbox ready). */
  async onApplicationBootstrap(): Promise<void> {
    // groupId defaults to the clientId: 'profiles-service'.
    await this.kafka.subscribe({
      topic: Topics.ORDERS_EVENTS,
      handler: (envelope) => this.onOrderEvent(envelope),
    });
  }

  async onOrderEvent(envelope: EventEnvelope): Promise<void> {
    const { eventId, eventType, correlationId } = envelope;

    if (eventType === 'OrderCreated') {
      const order = parseOrderCreated(envelope.payload);
      const outcome = await this.startAssignment.execute({
        eventId,
        correlationId,
        ...order,
        version: envelope.aggregateVersion ?? 1,
      });
      this.logger.log({
        msg: 'OrderCreated handled',
        outcome,
        orderId: order.orderId,
        correlationId,
      });
      return;
    }

    const status = STATUS_BY_EVENT[eventType];
    if (!status) {
      this.logger.debug?.({ msg: 'Event ignored', eventType, eventId });
      return;
    }
    const change = parseOrderStatusEvent(
      eventType,
      envelope.payload,
      envelope.aggregateVersion,
    );
    const outcome = await this.trackOrderStatus.execute({
      eventId,
      eventType,
      status,
      ...change,
      correlationId,
    });
    this.logger.log({
      msg: `${eventType} handled`,
      outcome,
      orderId: change.orderId,
      correlationId,
    });
  }
}
