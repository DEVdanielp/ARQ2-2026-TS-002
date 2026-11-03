/**
 * The events this service publishes (spec 5.4), as outbox messages or intent
 * envelopes. Each one is created once, when its fact happens; re-sends keep
 * the eventId (ADR-009).
 *
 * `IntentRejected` is not in the spec's catalog yet. Spec 4.2 and F4-S6 require
 * a rejection to reach `TrackingView.lastRejectedIntent`, and the view is built
 * only from events, so it needs one. It is additive (spec 5.2): every current
 * consumer of `orders.events` ignores event types it does not know. It does not
 * change the order, so it repeats the current version rather than raising it.
 */
import {
  createEnvelope,
  Topics,
  type EventEnvelope,
} from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type {
  Intent,
  IntentType,
  Order,
  OrderStatus,
  TransitionEvent,
} from '../domain/order.js';

const PRODUCER = 'orders-service';
const SCHEMA_VERSION = 1;

/** Event name of each intent on `orders.intents` (spec 5.4). */
export const INTENT_EVENTS: Record<IntentType, string> = {
  PICKUP_CONFIRMED: 'PickupConfirmed',
  DELIVERY_CONFIRMED: 'DeliveryConfirmed',
  CANCELLATION_REQUESTED: 'CancellationRequested',
};

export interface IntentPayload {
  intentId: string;
  orderId: string;
  type: IntentType;
  actor: Intent['actor'];
  actorId: string;
  reason?: string;
  requestedAt: string;
}

function orderEvent<TPayload>(
  eventType: string,
  order: Order,
  correlationId: string,
  payload: TPayload,
): OutboxMessage<TPayload> {
  return {
    topic: Topics.ORDERS_EVENTS,
    key: order.orderId,
    envelope: createEnvelope({
      eventType,
      schemaVersion: SCHEMA_VERSION,
      producer: PRODUCER,
      correlationId,
      aggregateId: order.orderId,
      aggregateVersion: order.version,
      payload,
    }),
  };
}

export function orderCreated(
  order: Order,
  correlationId: string,
): OutboxMessage {
  return orderEvent('OrderCreated', order, correlationId, {
    orderId: order.orderId,
    customerId: order.customerId,
    status: order.status,
    destination: order.destination,
  });
}

export function orderTransitioned(
  eventType: TransitionEvent,
  order: Order,
  previousStatus: OrderStatus,
  correlationId: string,
): OutboxMessage {
  return orderEvent(eventType, order, correlationId, {
    orderId: order.orderId,
    status: order.status,
    previousStatus,
    driverId: order.driverId,
    ...(order.cancellation ? { cancellation: order.cancellation } : {}),
    changedAt: order.updatedAt.toISOString(),
  });
}

export function intentRejected(
  order: Order,
  intentId: string,
  type: IntentType,
  reason: string,
  at: Date,
  correlationId: string,
): OutboxMessage {
  return orderEvent('IntentRejected', order, correlationId, {
    orderId: order.orderId,
    intentId,
    // Same shape as `TrackingView.lastRejectedIntent` (spec 3).
    lastRejectedIntent: { type, reason, at: at.toISOString() },
  });
}

/** The eventId IS the intentId, which the state engine deduplicates by (spec 5.4). */
export function intentEnvelope(
  payload: IntentPayload,
  correlationId: string,
): EventEnvelope<IntentPayload> {
  return {
    ...createEnvelope({
      eventType: INTENT_EVENTS[payload.type],
      schemaVersion: SCHEMA_VERSION,
      producer: PRODUCER,
      correlationId,
      aggregateId: payload.orderId,
      aggregateVersion: null,
      payload,
    }),
    eventId: payload.intentId,
  };
}
