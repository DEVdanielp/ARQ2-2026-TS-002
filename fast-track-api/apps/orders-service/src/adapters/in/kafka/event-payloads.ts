/**
 * Payloads of the events this service consumes (spec 5.4), and the checks
 * that a received payload really has the fields we use.
 *
 * `@libs/kafka` only guarantees a valid ENVELOPE. A payload that fails the
 * check throws InvalidPayloadError: the consumer retries it and then parks it
 * in `<topic>.dlq`, where it stays visible.
 */
import {
  IntentTypes,
  type Intent,
  type IntentActor,
  type IntentType,
} from '../../../domain/order.js';
import { INTENT_EVENTS } from '../../../application/events.js';

export class InvalidPayloadError extends Error {
  constructor(eventType: string, field: string) {
    super(`${eventType} payload has no valid "${field}"`);
    this.name = 'InvalidPayloadError';
  }
}

type Payload = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTENT_ACTORS: readonly string[] = ['CUSTOMER', 'DRIVER', 'OPERATIONS'];

function asObject(eventType: string, value: unknown): Payload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidPayloadError(eventType, 'payload');
  return value as Payload;
}

/** Ids are UUIDs in every FastTrack table (spec 2, IDs); anything else would only fail later in SQL. */
function requireUuid(
  eventType: string,
  payload: Payload,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || !UUID.test(value))
    throw new InvalidPayloadError(eventType, field);
  return value;
}

/** True for the event names of `orders.intents`. */
export function isIntentEvent(eventType: string): boolean {
  return Object.values(INTENT_EVENTS).includes(eventType);
}

/** PickupConfirmed / DeliveryConfirmed / CancellationRequested. */
export function parseIntent(
  eventType: string,
  payload: unknown,
): { orderId: string; intent: Intent } {
  const p = asObject(eventType, payload);
  const type = p.type as IntentType;
  if (!IntentTypes.includes(type) || INTENT_EVENTS[type] !== eventType)
    throw new InvalidPayloadError(eventType, 'type');
  if (typeof p.actor !== 'string' || !INTENT_ACTORS.includes(p.actor))
    throw new InvalidPayloadError(eventType, 'actor');
  if (p.reason !== undefined && typeof p.reason !== 'string')
    throw new InvalidPayloadError(eventType, 'reason');
  return {
    orderId: requireUuid(eventType, p, 'orderId'),
    intent: {
      type,
      actor: p.actor as IntentActor,
      actorId: requireUuid(eventType, p, 'actorId'),
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };
}

/** DriverAssigned / DriverUnassigned: only the order and its driver matter here. */
export function parseDriverChange(
  eventType: string,
  payload: unknown,
): { orderId: string; driverId: string } {
  const p = asObject(eventType, payload);
  return {
    orderId: requireUuid(eventType, p, 'orderId'),
    driverId: requireUuid(eventType, p, 'driverId'),
  };
}
