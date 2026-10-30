/**
 * Payloads of the events this worker consumes (spec 5.4), and the checks that
 * a received payload really has the fields we use.
 *
 * `@libs/kafka` only guarantees a valid ENVELOPE; the payload comes from
 * another service, so we verify what we rely on before touching the
 * database. A payload that fails throws InvalidPayloadError: the consumer
 * retries it (pointlessly, but harmlessly) and then parks it in `<topic>.dlq`,
 * where it stays visible (ADR-012).
 */
import type { GpsBatchReceivedPayload, GpsPoint } from '@libs/events';
import type { DriverAssignment, DriverUnassignment } from '../../../application/ports.js';

export class InvalidPayloadError extends Error {
  constructor(eventType: string, field: string) {
    super(`${eventType} payload has no valid "${field}"`);
    this.name = 'InvalidPayloadError';
  }
}

type Payload = Record<string, unknown>;

/** Any UUID (the database columns are `uuid`; spec 2 says IDs are UUID v4). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asObject(eventType: string, value: unknown, field = 'payload'): Payload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidPayloadError(eventType, field);
  return value as Payload;
}

function requireUuid(eventType: string, payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidPayloadError(eventType, field);
  return value;
}

function requireNumber(eventType: string, payload: Payload, field: string, min: number, max: number): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new InvalidPayloadError(eventType, field);
  }
  return value;
}

function requireTime(eventType: string, payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new InvalidPayloadError(eventType, field);
  return value;
}

function optionalMeasure(eventType: string, payload: Payload, field: string): number | undefined {
  return payload[field] === undefined || payload[field] === null
    ? undefined
    : requireNumber(eventType, payload, field, 0, Number.MAX_VALUE);
}

function parsePoint(value: unknown, index: number): GpsPoint {
  const type = 'GpsBatchReceived';
  const p = asObject(type, value, `points.${index}`);
  const sequence = p.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new InvalidPayloadError(type, `points.${index}.sequence`);
  }
  const accuracyMeters = optionalMeasure(type, p, 'accuracyMeters');
  const speedKmh = optionalMeasure(type, p, 'speedKmh');
  return {
    lat: requireNumber(type, p, 'lat', -90, 90),
    lng: requireNumber(type, p, 'lng', -180, 180),
    // Stored as timestamptz: normalise to UTC (the API already does; be strict anyway).
    deviceTime: new Date(requireTime(type, p, 'deviceTime')).toISOString(),
    sequence,
    ...(accuracyMeters !== undefined && { accuracyMeters }),
    ...(speedKmh !== undefined && { speedKmh }),
  };
}

export function parseGpsBatchReceived(payload: unknown): GpsBatchReceivedPayload {
  const type = 'GpsBatchReceived';
  const p = asObject(type, payload);
  if (!Array.isArray(p.points) || p.points.length === 0) throw new InvalidPayloadError(type, 'points');
  return {
    driverId: requireUuid(type, p, 'driverId'),
    batchId: requireUuid(type, p, 'batchId'),
    receivedAt: requireTime(type, p, 'receivedAt'),
    points: p.points.map(parsePoint),
  };
}

/** DriverAssigned: `{ orderId, driverId, destination: { location: { lat, lng } }, ... }`. */
export function parseDriverAssigned(payload: unknown): DriverAssignment {
  const type = 'DriverAssigned';
  const p = asObject(type, payload);
  const destination = asObject(type, p.destination, 'destination');
  const location = asObject(type, destination.location, 'destination.location');
  return {
    orderId: requireUuid(type, p, 'orderId'),
    driverId: requireUuid(type, p, 'driverId'),
    destination: {
      lat: requireNumber(type, location, 'lat', -90, 90),
      lng: requireNumber(type, location, 'lng', -180, 180),
    },
  };
}

export function parseDriverUnassigned(payload: unknown): DriverUnassignment {
  const type = 'DriverUnassigned';
  const p = asObject(type, payload);
  return { orderId: requireUuid(type, p, 'orderId'), driverId: requireUuid(type, p, 'driverId') };
}

/** OrderOnTheWay / OrderDelivered / OrderCancelled: the order, its version and (optionally) its driver. */
export function parseOrderStatusEvent(
  eventType: string,
  payload: unknown,
  aggregateVersion: number | null | undefined,
): { orderId: string; version: number; driverId: string | null } {
  const p = asObject(eventType, payload);
  if (typeof aggregateVersion !== 'number' || !Number.isInteger(aggregateVersion) || aggregateVersion < 1) {
    throw new InvalidPayloadError(eventType, 'aggregateVersion');
  }
  const driverId = typeof p.driverId === 'string' && UUID.test(p.driverId) ? p.driverId : null;
  return { orderId: requireUuid(eventType, p, 'orderId'), version: aggregateVersion, driverId };
}
