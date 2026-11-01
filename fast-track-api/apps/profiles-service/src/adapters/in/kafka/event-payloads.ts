/**
 * Payloads of the events this service consumes (spec 5.4), and the checks
 * that a received payload really has the fields we use.
 *
 * `@libs/kafka` only guarantees a valid ENVELOPE; the payload comes from the
 * Orders Service, so we verify the fields we rely on. A payload that fails the
 * check throws InvalidPayloadError: the consumer retries it and then parks it
 * in `orders.events.dlq`, where it stays visible.
 */
import type { Destination } from '../../../domain/profiles.js';

export class InvalidPayloadError extends Error {
  constructor(eventType: string, field: string) {
    super(`${eventType} payload has no valid "${field}"`);
    this.name = 'InvalidPayloadError';
  }
}

type Payload = Record<string, unknown>;

function asObject(
  eventType: string,
  value: unknown,
  field = 'payload',
): Payload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidPayloadError(eventType, field);
  return value as Payload;
}

function requireString(
  eventType: string,
  payload: Payload,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new InvalidPayloadError(eventType, field);
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are UUIDs in every FastTrack table (spec 2, IDs); anything else would only fail later in SQL. */
function requireUuid(
  eventType: string,
  payload: Payload,
  field: string,
): string {
  const value = requireString(eventType, payload, field);
  if (!UUID.test(value)) throw new InvalidPayloadError(eventType, field);
  return value;
}

function requireCoordinate(
  eventType: string,
  payload: Payload,
  field: string,
  limit: number,
  path: string,
): number {
  const value = payload[field];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > limit
  )
    throw new InvalidPayloadError(eventType, path);
  return value;
}

/** Fields of OrderCreated we use: the destination is required, DriverAssigned must carry it (ADR-018). */
export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  destination: Destination;
}

export function parseOrderCreated(payload: unknown): OrderCreatedPayload {
  const type = 'OrderCreated';
  const p = asObject(type, payload);
  const destination = asObject(type, p.destination, 'destination');
  const location = asObject(type, destination.location, 'destination.location');
  return {
    orderId: requireUuid(type, p, 'orderId'),
    customerId: requireUuid(type, p, 'customerId'),
    destination: {
      address:
        typeof destination.address === 'string' ? destination.address : null,
      location: {
        lat: requireCoordinate(
          type,
          location,
          'lat',
          90,
          'destination.location.lat',
        ),
        lng: requireCoordinate(
          type,
          location,
          'lng',
          180,
          'destination.location.lng',
        ),
      },
    },
  };
}

/** OrderOnTheWay / OrderDelivered / OrderCancelled: the order, its version and (optionally) its driver. */
export function parseOrderStatusEvent(
  eventType: string,
  payload: unknown,
  aggregateVersion: number | null | undefined,
): { orderId: string; version: number; driverId: string | null } {
  const p = asObject(eventType, payload);
  if (
    typeof aggregateVersion !== 'number' ||
    !Number.isInteger(aggregateVersion) ||
    aggregateVersion < 1
  ) {
    throw new InvalidPayloadError(eventType, 'aggregateVersion');
  }
  const driverId =
    typeof p.driverId === 'string' && UUID.test(p.driverId) ? p.driverId : null;
  return {
    orderId: requireUuid(eventType, p, 'orderId'),
    version: aggregateVersion,
    driverId,
  };
}
