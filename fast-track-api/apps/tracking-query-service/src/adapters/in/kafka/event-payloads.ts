/**
 * Turns each consumed event (spec 5.4) into the ViewChange it causes.
 *
 * `@libs/kafka` only guarantees a valid ENVELOPE; the payload comes from
 * another team's service, so we verify the fields we rely on. A payload that
 * fails the check throws InvalidPayloadError: the consumer retries it and then
 * parks it in `<topic>.dlq`, where it stays visible.
 *
 * Events this service does not use (e.g. PickupConfirmed on a shared topic)
 * map to null and are ignored.
 */
import type { EventEnvelope } from '@libs/events';
import type { GeoLocation } from '@libs/events';
import type { Destination, OrderStatus } from '../../../domain/tracking-view.js';
import type { ViewChange } from '../../../domain/view-change.js';

export class InvalidPayloadError extends Error {
  constructor(eventType: string, field: string) {
    super(`${eventType} payload has no valid "${field}"`);
    this.name = 'InvalidPayloadError';
  }
}

type Payload = Record<string, unknown>;

/** Status events of orders.events and the status they set (spec 1, Order lifecycle). */
const STATUS_BY_EVENT: Record<string, OrderStatus> = {
  OrderCreated: 'CREATED',
  OrderOnTheWay: 'ON_THE_WAY',
  OrderDelivered: 'DELIVERED',
  OrderCancelled: 'CANCELLED',
};

/** @returns the change to apply, or null for an event Tracking Query does not use. */
export function toViewChange(envelope: EventEnvelope): ViewChange | null {
  const { eventType } = envelope;
  const status = STATUS_BY_EVENT[eventType];
  if (status) return statusChange(envelope, status);

  switch (eventType) {
    case 'DriverAssigned': {
      const p = asObject(eventType, envelope.payload);
      const destination = optionalDestination(eventType, p.destination);
      return {
        kind: 'assigned',
        orderId: requireString(eventType, p, 'orderId'),
        driverId: requireString(eventType, p, 'driverId'),
        driverName: optionalString(p.driverName),
        destination,
        at: eventTime(envelope, p.assignedAt),
      };
    }
    case 'DriverUnassigned': {
      const p = asObject(eventType, envelope.payload);
      return {
        kind: 'unassigned',
        orderId: requireString(eventType, p, 'orderId'),
        driverId: requireString(eventType, p, 'driverId'),
        at: eventTime(envelope, p.unassignedAt),
      };
    }
    case 'AssignmentFailed': {
      const p = asObject(eventType, envelope.payload);
      return { kind: 'failed', orderId: requireString(eventType, p, 'orderId'), at: eventTime(envelope, p.failedAt) };
    }
    case 'LocationUpdated': {
      const p = asObject(eventType, envelope.payload);
      const sequence = p.sequence;
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new InvalidPayloadError(eventType, 'sequence');
      return {
        kind: 'location',
        orderId: requireString(eventType, p, 'orderId'),
        driverId: requireString(eventType, p, 'driverId'),
        location: requireLocation(eventType, p.location, 'location'),
        deviceTime: requireInstant(eventType, p, 'deviceTime'),
        sequence: sequence as number,
      };
    }
    case 'DriverNearDestination': {
      const p = asObject(eventType, envelope.payload);
      return { kind: 'nearby', orderId: requireString(eventType, p, 'orderId') };
    }
    default:
      return null;
  }
}

function statusChange(envelope: EventEnvelope, status: OrderStatus): ViewChange {
  const { eventType } = envelope;
  const p = asObject(eventType, envelope.payload);
  // OrderCreated has aggregateVersion = 1 (spec 5.4); every transition carries its version.
  const version = envelope.aggregateVersion ?? (eventType === 'OrderCreated' ? 1 : null);
  if (!Number.isInteger(version) || (version as number) < 1) throw new InvalidPayloadError(eventType, 'aggregateVersion');

  if (eventType === 'OrderCreated') {
    return {
      kind: 'status',
      orderId: requireString(eventType, p, 'orderId'),
      status,
      version: version as number,
      customerId: requireString(eventType, p, 'customerId'),
      destination: optionalDestination(eventType, p.destination),
    };
  }
  return {
    kind: 'status',
    orderId: requireString(eventType, p, 'orderId'),
    status,
    version: version as number,
    driverId: optionalString(p.driverId),
  };
}

function asObject(eventType: string, payload: unknown): Payload {
  if (typeof payload !== 'object' || payload === null) throw new InvalidPayloadError(eventType, 'payload');
  return payload as Payload;
}

function requireString(eventType: string, payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) throw new InvalidPayloadError(eventType, field);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireInstant(eventType: string, payload: Payload, field: string): string {
  const value = requireString(eventType, payload, field);
  if (Number.isNaN(Date.parse(value))) throw new InvalidPayloadError(eventType, field);
  return value;
}

function requireLocation(eventType: string, value: unknown, field: string): GeoLocation {
  const location = value as Partial<GeoLocation> | null;
  const { lat, lng } = location ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new InvalidPayloadError(eventType, field);
  }
  return { lat, lng };
}

/** `{ address?, location }`; absent is fine, malformed is not. */
function optionalDestination(eventType: string, value: unknown): Destination | undefined {
  if (value === undefined || value === null) return undefined;
  const d = asObject(eventType, value);
  const location = requireLocation(eventType, d.location, 'destination.location');
  const address = optionalString(d.address);
  return address ? { address, location } : { location };
}

/** Time of an assignment fact (epoch ms): the payload's own timestamp, else the envelope's. */
function eventTime(envelope: EventEnvelope, payloadTime: unknown): number {
  const time = Date.parse(typeof payloadTime === 'string' ? payloadTime : envelope.occurredAt);
  if (Number.isNaN(time)) throw new InvalidPayloadError(envelope.eventType, 'occurredAt');
  return time;
}
