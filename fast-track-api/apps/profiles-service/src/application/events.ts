/**
 * The events this service publishes (spec 5.4), built as outbox messages.
 *
 * Every event is created ONCE here, at the moment the fact happens, and
 * written to the outbox in the same transaction as the change it describes
 * (ADR-005). Keys follow spec 5.1: `orderId` on `assignment.events`,
 * `customerId` on `profile.events`.
 *
 * Who consumes them (and therefore which fields are required):
 * - DriverAssigned:   Orders, GPS Tracking Worker (needs destination.location), Tracking Query (driverName, assignedAt).
 * - DriverUnassigned: Orders, GPS Tracking Worker, Tracking Query (unassignedAt).
 * - AssignmentFailed: Tracking Query (failedAt), Notifications (alert to operations).
 * - CustomerContactUpdated: Notifications (keeps the highest aggregateVersion).
 */
import { createEnvelope, Topics } from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type {
  AssignmentRequest,
  Customer,
  Driver,
} from '../domain/profiles.js';

export const PRODUCER = 'profiles-service';

export interface DriverAssignedPayload {
  orderId: string;
  driverId: string;
  driverName: string;
  destination: { location: { lat: number; lng: number } };
  assignedAt: string;
}

export interface DriverUnassignedPayload {
  orderId: string;
  driverId: string;
  reason: 'DRIVER_OFFLINE';
  unassignedAt: string;
}

export interface AssignmentFailedPayload {
  orderId: string;
  attempts: number;
  windowStartedAt: string;
  failedAt: string;
}

export interface CustomerContactUpdatedPayload {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
}

export function driverAssigned(
  request: AssignmentRequest,
  driver: Driver,
  at: Date,
  correlationId: string,
): OutboxMessage<DriverAssignedPayload> {
  return {
    topic: Topics.ASSIGNMENT_EVENTS,
    key: request.orderId,
    envelope: createEnvelope({
      eventType: 'DriverAssigned',
      schemaVersion: 1,
      producer: PRODUCER,
      correlationId,
      aggregateId: request.orderId,
      aggregateVersion: null,
      payload: {
        orderId: request.orderId,
        driverId: driver.driverId,
        driverName: driver.name,
        destination: {
          location: {
            lat: request.destination.location.lat,
            lng: request.destination.location.lng,
          },
        },
        assignedAt: at.toISOString(),
      },
    }),
  };
}

export function driverUnassigned(
  orderId: string,
  driverId: string,
  at: Date,
  correlationId: string,
): OutboxMessage<DriverUnassignedPayload> {
  return {
    topic: Topics.ASSIGNMENT_EVENTS,
    key: orderId,
    envelope: createEnvelope({
      eventType: 'DriverUnassigned',
      schemaVersion: 1,
      producer: PRODUCER,
      correlationId,
      aggregateId: orderId,
      aggregateVersion: null,
      payload: {
        orderId,
        driverId,
        reason: 'DRIVER_OFFLINE',
        unassignedAt: at.toISOString(),
      },
    }),
  };
}

export function assignmentFailed(
  request: AssignmentRequest,
  at: Date,
  correlationId: string,
): OutboxMessage<AssignmentFailedPayload> {
  return {
    topic: Topics.ASSIGNMENT_EVENTS,
    key: request.orderId,
    envelope: createEnvelope({
      eventType: 'AssignmentFailed',
      schemaVersion: 1,
      producer: PRODUCER,
      correlationId,
      aggregateId: request.orderId,
      aggregateVersion: null,
      payload: {
        orderId: request.orderId,
        attempts: request.attempts,
        windowStartedAt: request.windowStartedAt.toISOString(),
        failedAt: at.toISOString(),
      },
    }),
  };
}

/** `aggregateVersion` = the customer's contact version, so consumers keep the newest copy (spec 5.4). */
export function customerContactUpdated(
  customer: Customer,
  correlationId: string,
): OutboxMessage<CustomerContactUpdatedPayload> {
  return {
    topic: Topics.PROFILE_EVENTS,
    key: customer.customerId,
    envelope: createEnvelope({
      eventType: 'CustomerContactUpdated',
      schemaVersion: 1,
      producer: PRODUCER,
      correlationId,
      aggregateId: customer.customerId,
      aggregateVersion: customer.contactVersion,
      payload: {
        customerId: customer.customerId,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
    }),
  };
}
