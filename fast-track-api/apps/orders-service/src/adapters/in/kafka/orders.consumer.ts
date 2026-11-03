/**
 * Kafka inbound adapter: routes each event to its use case (consumer group
 * `orders-service`).
 *
 * | Topic             | Event                                                | Use case               |
 * | ----------------- | ---------------------------------------------------- | ---------------------- |
 * | orders.intents    | PickupConfirmed, DeliveryConfirmed, CancellationRequested | ApplyIntent       |
 * | assignment.events | DriverAssigned                                       | RecordDriverAssigned   |
 * | assignment.events | DriverUnassigned                                     | RecordDriverUnassigned |
 *
 * `AssignmentFailed` is ignored on purpose: the order stays `CREATED` (spec 1).
 *
 * Error policy (from @libs/kafka): a handler that throws is retried in process
 * (200 ms, 1 s, 5 s) and then sent to `<topic>.dlq`. An invalid transition does
 * not throw: it is an outcome, recorded and never retried (spec 5.4).
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';
import {
  ApplyIntent,
  RecordDriverAssigned,
  RecordDriverUnassigned,
} from '../../../application/state-engine.use-cases.js';
import {
  isIntentEvent,
  parseDriverChange,
  parseIntent,
} from './event-payloads.js';

@Injectable()
export class OrdersConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor(
    private readonly kafka: KafkaConsumerService,
    private readonly applyIntent: ApplyIntent,
    private readonly recordDriverAssigned: RecordDriverAssigned,
    private readonly recordDriverUnassigned: RecordDriverUnassigned,
  ) {}

  /** Runs after every module is initialised (producer and outbox ready). */
  async onApplicationBootstrap(): Promise<void> {
    // groupId defaults to the clientId: 'orders-service'.
    await this.kafka.subscribe({
      topic: Topics.ORDERS_INTENTS,
      handler: (e) => this.onIntent(e),
    });
    await this.kafka.subscribe({
      topic: Topics.ASSIGNMENT_EVENTS,
      handler: (e) => this.onAssignmentEvent(e),
    });
  }

  /** orders.intents */
  async onIntent(envelope: EventEnvelope): Promise<void> {
    const { eventId, eventType, correlationId } = envelope;
    if (!isIntentEvent(eventType)) return this.ignore(envelope);

    const { orderId, intent } = parseIntent(eventType, envelope.payload);
    const outcome = await this.applyIntent.execute({
      intentId: eventId,
      eventType,
      orderId,
      intent,
      correlationId,
    });
    this.logger.log({ msg: `${eventType} handled`, outcome, orderId, correlationId });
  }

  /** assignment.events */
  async onAssignmentEvent(envelope: EventEnvelope): Promise<void> {
    const { eventId, eventType, correlationId } = envelope;
    const useCase =
      eventType === 'DriverAssigned'
        ? this.recordDriverAssigned
        : eventType === 'DriverUnassigned'
          ? this.recordDriverUnassigned
          : null;
    if (!useCase) return this.ignore(envelope);

    const change = parseDriverChange(eventType, envelope.payload);
    const outcome = await useCase.execute({ eventId, eventType, ...change });
    this.logger.log({
      msg: `${eventType} handled`,
      outcome,
      orderId: change.orderId,
      correlationId,
    });
  }

  private ignore(envelope: EventEnvelope): void {
    this.logger.debug?.({
      msg: 'Event ignored',
      eventType: envelope.eventType,
      eventId: envelope.eventId,
    });
  }
}
