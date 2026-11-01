/**
 * Vocabulary of the Profiles & Assignment Service (F1), from docs/spec.md
 * section 3 (`Customer`, `Driver`, `DriverAvailability`, `OrderStatus`,
 * `Destination`).
 *
 * Plain types and constants only: no Nest, no TypeORM, no Kafka (ADR-014).
 * The rules that use them live next to this file (driver-rules.ts,
 * customer-rules.ts, assignment-window.ts).
 */

export const DriverAvailabilities = [
  'AVAILABLE',
  'EN_ROUTE',
  'OFFLINE',
] as const;
/** `EN_ROUTE` is set by the system (the driver has active orders); the driver only chooses AVAILABLE or OFFLINE. */
export type DriverAvailability = (typeof DriverAvailabilities)[number];

/** What a driver may request in `PATCH /drivers/me/availability` (spec 4.1). */
export const SelectableAvailabilities = ['AVAILABLE', 'OFFLINE'] as const;
export type SelectableAvailability = (typeof SelectableAvailabilities)[number];

export const OrderStatuses = [
  'CREATED',
  'ON_THE_WAY',
  'DELIVERED',
  'CANCELLED',
] as const;
/** Order status as last seen on `orders.events` (Orders is the source of truth, spec 1). */
export type OrderStatus = (typeof OrderStatuses)[number];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'DELIVERED',
  'CANCELLED',
];

/**
 * Where the search for a driver of one order stands (ADR-019).
 * - PENDING:  looking for a driver (retried every 30 s within the 10-minute window).
 * - ASSIGNED: the order has an active assignment.
 * - FAILED:   the window expired without a driver; `AssignmentFailed` was published.
 */
export const AssignmentStates = ['PENDING', 'ASSIGNED', 'FAILED'] as const;
export type AssignmentState = (typeof AssignmentStates)[number];

/** Why an assignment stopped being active (`assignments.release_reason`). */
export const ReleaseReasons = [
  'DELIVERED',
  'CANCELLED',
  'DRIVER_OFFLINE',
  'REASSIGNED',
] as const;
export type ReleaseReason = (typeof ReleaseReasons)[number];

/** WGS-84 decimal degrees (spec 2, Coordinates). */
export interface Location {
  lat: number;
  lng: number;
}

/** Spec 3 `Destination`. The address is optional here: only the location is needed to assign. */
export interface Destination {
  address: string | null;
  location: Location;
}

/** Spec 3 `Customer`. `contactVersion` is the `aggregateVersion` of `CustomerContactUpdated`. */
export interface Customer {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
  /** Increases every time a `CustomerContactUpdated` is published (spec 5.4: consumers keep the highest). */
  contactVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Spec 3 `Driver`, plus what the assignment rules need. */
export interface Driver {
  driverId: string;
  name: string;
  phone: string;
  vehiclePlate: string;
  availability: DriverAvailability;
  /** Max concurrent orders, 1–10. */
  capacity: number;
  /** Orders with an active assignment (spec 3 `activeOrderIds`). */
  activeOrderIds: string[];
  /** Last time an order was assigned to the driver; the tie-breaker of the selection rule. */
  lastAssignedAt: Date | null;
  createdAt: Date;
}

/**
 * Local copy of one order and the search for its driver (table
 * `assignment_requests`). Built from `orders.events` (ADR-015): Profiles never
 * queries Orders.
 */
export interface AssignmentRequest {
  orderId: string;
  customerId: string;
  destination: Destination;
  orderStatus: OrderStatus;
  /** Highest `aggregateVersion` applied; older or repeated order events are ignored. */
  orderVersion: number;
  state: AssignmentState;
  /** Driver of the active assignment, if any. */
  driverId: string | null;
  /** Assignment attempts in the current window (spec 5.4 `AssignmentFailed.attempts`). */
  attempts: number;
  /** Start of the current 10-minute window (restarted by `DriverUnassigned`). */
  windowStartedAt: Date;
  /** When the next attempt is due; null when no attempt is pending. */
  nextAttemptAt: Date | null;
  /** Correlation id of the `OrderCreated` that started the saga, copied into every event it causes. */
  correlationId: string;
}

/** One row of `assignments`: the audit trail of who had which order (spec 4.1 `GET /assignments`). */
export interface Assignment {
  orderId: string;
  driverId: string;
  assignedAt: Date;
  releasedAt: Date | null;
  releaseReason: ReleaseReason | null;
}

export const MIN_CAPACITY = 1;
export const MAX_CAPACITY = 10;
