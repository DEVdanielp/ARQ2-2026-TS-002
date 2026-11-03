/**
 * The changes an event can make to a tracking view, one per kind of event.
 *
 * The Kafka adapter turns each consumed event into one `ViewChange`; the store
 * applies it atomically with these guards (ADR-010, spec 5.4 "Idempotency"):
 *
 * | Change       | From event(s)                                    | Applied only if |
 * | ------------ | ------------------------------------------------ | --------------- |
 * | `status`     | OrderCreated, OrderOnTheWay/Delivered/Cancelled  | `version` > stored version (F3-S4, no regression) |
 * | `assigned`   | DriverAssigned                                   | order not terminal; not older than the last assignment change |
 * | `unassigned` | DriverUnassigned                                 | same driver still assigned, order still `CREATED` (or unknown yet), not older |
 * | `failed`     | AssignmentFailed                                 | order not terminal; not older than the last assignment change |
 * | `location`   | LocationUpdated                                  | `sequence` > stored sequence; order not terminal |
 * | `nearby`     | DriverNearDestination                            | not reached yet; order not terminal |
 *
 * Every applied change bumps the view `revision` and `updatedAt`. A terminal
 * status sets the 24 h expiry of the view (ADR-002, F3-S5).
 *
 * Assignment events carry no order version, so they are ordered by the time
 * the fact happened (`at`, epoch ms): they share the `assignment.events`
 * partition of the order, and the timestamp only protects against a stale
 * redelivery overwriting a newer assignment change.
 */
import type { GeoLocation } from '@libs/events';
import type { Destination, OrderStatus } from './tracking-view.js';

export interface StatusChange {
  kind: 'status';
  orderId: string;
  status: OrderStatus;
  version: number;
  /** From OrderCreated: owner of the order. */
  customerId?: string;
  /** From OrderCreated. */
  destination?: Destination;
  /** From OrderOnTheWay/Delivered/Cancelled, when present. */
  driverId?: string;
}

export interface AssignedChange {
  kind: 'assigned';
  orderId: string;
  driverId: string;
  driverName?: string;
  /** Used only if the view has no destination yet (OrderCreated not arrived). */
  destination?: Destination;
  at: number;
}

export interface UnassignedChange {
  kind: 'unassigned';
  orderId: string;
  driverId: string;
  at: number;
}

export interface AssignmentFailedChange {
  kind: 'failed';
  orderId: string;
  at: number;
}

export interface LocationChange {
  kind: 'location';
  orderId: string;
  driverId: string;
  location: GeoLocation;
  deviceTime: string;
  sequence: number;
}

export interface NearbyChange {
  kind: 'nearby';
  orderId: string;
}

export type ViewChange =
  | StatusChange
  | AssignedChange
  | UnassignedChange
  | AssignmentFailedChange
  | LocationChange
  | NearbyChange;
