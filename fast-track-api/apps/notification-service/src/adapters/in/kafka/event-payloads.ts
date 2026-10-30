/**
 * Payloads of the events this service consumes (spec 5.4), and the checks
 * that a received payload really has the fields we use.
 *
 * `@libs/kafka` only guarantees a valid ENVELOPE; the payload comes from
 * another team's service, so we verify the few fields we rely on. A payload
 * that fails the check throws InvalidPayloadError: the consumer retries it
 * (pointlessly, but harmlessly) and then parks it in `<topic>.dlq` where it
 * stays visible.
 */
import {
  NotificationChannels,
  NotificationTypes,
  type NotificationChannel,
  type NotificationType,
} from '../../../domain/notification.js';
import type { NotificationRetryPayload } from '../../../application/ports.js';
import type { AssignmentFailedPayload } from '../../../application/alert-operations.js';

export class InvalidPayloadError extends Error {
  constructor(eventType: string, field: string) {
    super(`${eventType} payload has no valid "${field}"`);
    this.name = 'InvalidPayloadError';
  }
}

type Payload = Record<string, unknown>;

function asObject(eventType: string, payload: unknown): Payload {
  if (typeof payload !== 'object' || payload === null) throw new InvalidPayloadError(eventType, 'payload');
  return payload as Payload;
}

function requireString(eventType: string, payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) throw new InvalidPayloadError(eventType, field);
  return value;
}

/** Fields of OrderCreated we use. */
export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
}

export function parseOrderCreated(payload: unknown): OrderCreatedPayload {
  const p = asObject('OrderCreated', payload);
  return { orderId: requireString('OrderCreated', p, 'orderId'), customerId: requireString('OrderCreated', p, 'customerId') };
}

/** OrderOnTheWay / OrderDelivered / OrderCancelled / DriverNearDestination: we only need the order. */
export function parseOrderId(eventType: string, payload: unknown): string {
  return requireString(eventType, asObject(eventType, payload), 'orderId');
}

export interface CustomerContactUpdatedPayload {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
}

export function parseCustomerContactUpdated(payload: unknown): CustomerContactUpdatedPayload {
  const type = 'CustomerContactUpdated';
  const p = asObject(type, payload);
  return {
    customerId: requireString(type, p, 'customerId'),
    name: requireString(type, p, 'name'),
    email: requireString(type, p, 'email'),
    phone: typeof p.phone === 'string' ? p.phone : null,
  };
}

export function parseAssignmentFailed(payload: unknown): AssignmentFailedPayload {
  const type = 'AssignmentFailed';
  const p = asObject(type, payload);
  return {
    orderId: requireString(type, p, 'orderId'),
    attempts: typeof p.attempts === 'number' ? p.attempts : undefined,
    windowStartedAt: typeof p.windowStartedAt === 'string' ? p.windowStartedAt : undefined,
    failedAt: typeof p.failedAt === 'string' ? p.failedAt : undefined,
  };
}

export function parseNotificationRetry(payload: unknown): NotificationRetryPayload {
  const type = 'NotificationRetry';
  const p = asObject(type, payload);
  const notificationType = p.type as NotificationType;
  const channel = p.channel as NotificationChannel;
  if (!NotificationTypes.includes(notificationType)) throw new InvalidPayloadError(type, 'type');
  if (!NotificationChannels.includes(channel)) throw new InvalidPayloadError(type, 'channel');
  if (!Number.isInteger(p.attempt) || (p.attempt as number) < 1) throw new InvalidPayloadError(type, 'attempt');
  return {
    orderId: requireString(type, p, 'orderId'),
    customerId: requireString(type, p, 'customerId'),
    type: notificationType,
    channel,
    attempt: p.attempt as number,
    notBefore: typeof p.notBefore === 'string' ? p.notBefore : new Date().toISOString(),
    lastError: typeof p.lastError === 'string' ? p.lastError : '',
  };
}
