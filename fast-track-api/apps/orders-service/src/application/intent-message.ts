import { isUuid, type UserRole } from '../domain/order.js';
import type { EventEnvelope } from './outbox-port.js';
import type { IntentMessage } from './state-engine.port.js';

const INTENT_EVENT_TYPES = {
  PickupConfirmed: 'PICKUP_CONFIRMED',
  DeliveryConfirmed: 'DELIVERY_CONFIRMED',
  CancellationRequested: 'CANCELLATION_REQUESTED',
} as const;
const ACTORS: UserRole[] = ['CUSTOMER', 'DRIVER', 'OPERATIONS'];

export function parseIntentMessage(
  value: Buffer | null,
  topic: string,
  partition: number,
  offset: string,
): IntentMessage {
  if (!value) {
    throw new Error('Intent message has no value.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Intent message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(decoded) || !isRecord(decoded.payload)) {
    throw new Error('Intent message must contain an event envelope and payload.');
  }
  const event = decoded as unknown as EventEnvelope;
  const intentType =
    INTENT_EVENT_TYPES[event.eventType as keyof typeof INTENT_EVENT_TYPES];
  const payload = decoded.payload;
  if (
    !intentType ||
    payload.type !== intentType ||
    !isUuid(event.eventId) ||
    payload.intentId !== event.eventId ||
    !isUuid(event.aggregateId) ||
    payload.orderId !== event.aggregateId ||
    !isUuid(event.correlationId) ||
    event.schemaVersion !== 1 ||
    typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    typeof event.producer !== 'string' ||
    !isUuid(payload.actorId) ||
    typeof payload.actor !== 'string' ||
    !ACTORS.includes(payload.actor as UserRole) ||
    typeof payload.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.requestedAt)) ||
    (payload.reason !== undefined && typeof payload.reason !== 'string')
  ) {
    throw new Error('Intent message envelope or payload is invalid.');
  }

  return {
    event,
    intent: {
      intentId: event.eventId,
      type: intentType,
      actor: payload.actor as UserRole,
      actorId: payload.actorId,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      requestedAt: payload.requestedAt,
    },
    topic,
    partition,
    offset,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
