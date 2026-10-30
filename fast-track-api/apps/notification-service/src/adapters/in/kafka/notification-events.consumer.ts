/**
 * Kafka inbound adapter: subscribes to the topics this service consumes and
 * routes each event to its use case.
 *
 * | Topic               | Event                                      | Use case                    |
 * | ------------------- | ------------------------------------------ | --------------------------- |
 * | orders.events       | OrderCreated                               | RecordOrderRecipient (+ opt-in ORDER_CREATED) |
 * | orders.events       | OrderOnTheWay, OrderDelivered, OrderCancelled | NotifyCustomer           |
 * | tracking.proximity  | DriverNearDestination                      | NotifyCustomer (NEARBY)     |
 * | assignment.events   | AssignmentFailed                           | AlertOperations             |
 * | profile.events      | CustomerContactUpdated                     | ReplicateCustomerContact    |
 * | notifications.retry | NotificationRetry                          | RetryNotification           |
 *
 * ONE subscription per topic: every `subscribe()` creates a consumer, and two
 * consumers of the same group on the same topic would split its partitions,
 * each seeing only part of the events. Events we do not need (for example
 * DriverAssigned on assignment.events) are ignored without error.
 *
 * Error policy (from @libs/kafka): a handler that throws is retried in
 * process (200 ms, 1 s, 5 s) and then sent to `<topic>.dlq`. Use cases throw
 * only when retrying can help (unknown recipient yet, database down) or the
 * payload is invalid. Provider failures do NOT throw: they are retried
 * through notifications.retry instead (ADR-012, ADR-017).
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';
import type { NotificationType } from '../../../domain/notification.js';
import { AlertOperations } from '../../../application/alert-operations.js';
import { NotifyCustomer } from '../../../application/notify-customer.js';
import { RecordOrderRecipient, ReplicateCustomerContact } from '../../../application/replication.use-cases.js';
import { RetryNotification } from '../../../application/retry-notification.js';
import {
  parseAssignmentFailed,
  parseCustomerContactUpdated,
  parseNotificationRetry,
  parseOrderCreated,
  parseOrderId,
} from './event-payloads.js';

/** Order status events that notify the customer (F5-S3). */
const ORDER_EVENT_TYPES: Record<string, NotificationType> = {
  OrderOnTheWay: 'ON_THE_WAY',
  OrderDelivered: 'DELIVERED',
  OrderCancelled: 'CANCELLED',
};

@Injectable()
export class NotificationEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationEventsConsumer.name);

  constructor(
    private readonly kafka: KafkaConsumerService,
    private readonly recordOrderRecipient: RecordOrderRecipient,
    private readonly replicateContact: ReplicateCustomerContact,
    private readonly notifyCustomer: NotifyCustomer,
    private readonly retryNotification: RetryNotification,
    private readonly alertOperations: AlertOperations,
  ) {}

  /** Runs after every module is initialised (producer and outbox ready). */
  async onApplicationBootstrap(): Promise<void> {
    // groupId defaults to the clientId: 'notification-service'.
    await this.kafka.subscribe({ topic: Topics.ORDERS_EVENTS, handler: (e) => this.onOrderEvent(e) });
    await this.kafka.subscribe({ topic: Topics.TRACKING_PROXIMITY, handler: (e) => this.onProximityEvent(e) });
    await this.kafka.subscribe({ topic: Topics.ASSIGNMENT_EVENTS, handler: (e) => this.onAssignmentEvent(e) });
    await this.kafka.subscribe({ topic: Topics.PROFILE_EVENTS, handler: (e) => this.onProfileEvent(e) });
    await this.kafka.subscribe({ topic: Topics.NOTIFICATIONS_RETRY, handler: (e) => this.onRetryEvent(e) });
  }

  /** orders.events */
  async onOrderEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType === 'OrderCreated') {
      const { orderId, customerId } = parseOrderCreated(envelope.payload);
      await this.recordOrderRecipient.execute(orderId, customerId);
      // ORDER_CREATED is opt-in; NotifyCustomer checks notifyOnCreated.
      await this.notifyCustomer.execute({ orderId, type: 'ORDER_CREATED', correlationId: envelope.correlationId });
      return;
    }

    const type = ORDER_EVENT_TYPES[envelope.eventType];
    if (!type) return this.ignore(envelope);
    const orderId = parseOrderId(envelope.eventType, envelope.payload);
    await this.notifyCustomer.execute({ orderId, type, correlationId: envelope.correlationId });
  }

  /** tracking.proximity */
  async onProximityEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== 'DriverNearDestination') return this.ignore(envelope);
    const orderId = parseOrderId(envelope.eventType, envelope.payload);
    await this.notifyCustomer.execute({ orderId, type: 'NEARBY', correlationId: envelope.correlationId });
  }

  /** assignment.events */
  async onAssignmentEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== 'AssignmentFailed') return this.ignore(envelope);
    await this.alertOperations.execute({ ...envelope, payload: parseAssignmentFailed(envelope.payload) });
  }

  /** profile.events */
  async onProfileEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== 'CustomerContactUpdated') return this.ignore(envelope);
    const contact = parseCustomerContactUpdated(envelope.payload);
    await this.replicateContact.execute(contact, envelope.aggregateVersion ?? null);
  }

  /** notifications.retry */
  async onRetryEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== 'NotificationRetry') return this.ignore(envelope);
    await this.retryNotification.execute({ ...envelope, payload: parseNotificationRetry(envelope.payload) });
  }

  private ignore(envelope: EventEnvelope): void {
    this.logger.debug?.({ msg: 'Event ignored', eventType: envelope.eventType, eventId: envelope.eventId });
  }
}
