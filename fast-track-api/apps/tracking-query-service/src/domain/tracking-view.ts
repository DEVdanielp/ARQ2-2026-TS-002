/**
 * The per-order tracking view (spec 3, `TrackingView`) and its read-time rules.
 *
 * Why it exists
 * -------------
 * Tracking Query is the CQRS read side (ADR-002): it never decides anything
 * about an order, it only keeps the latest picture of it, built from events.
 * Two rules belong to the view itself and are tested here, with no Redis or
 * PostgreSQL involved (ADR-014):
 *
 * - `locationAgeSeconds` and `trackingAvailable` are computed AT READ TIME
 *   from the device time of the last location (spec 4.4, F3-S2/F3-S3). A
 *   stale location never changes the `status`.
 * - Who may read a view: the customer who owns the order, or operations
 *   (spec 4.4, Auth).
 *
 * The rules that decide whether an event may CHANGE a stored view (versions,
 * sequences) are applied atomically inside Redis (ADR-010); their vocabulary
 * is in view-change.ts.
 */
import type { GeoLocation } from '@libs/events';

export const OrderStatuses = ['CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = (typeof OrderStatuses)[number];

/** `DELIVERED` and `CANCELLED` are terminal (spec 1, Order lifecycle). */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['DELIVERED', 'CANCELLED'];

export function isTerminal(status: OrderStatus | null | undefined): boolean {
  return status != null && TERMINAL_STATUSES.includes(status);
}

/** PENDING while looking for a driver; FAILED after `AssignmentFailed` (spec 3). */
export const AssignmentStatuses = ['PENDING', 'ASSIGNED', 'FAILED'] as const;
export type AssignmentStatus = (typeof AssignmentStatuses)[number];

export const IntentTypes = ['PICKUP_CONFIRMED', 'DELIVERY_CONFIRMED', 'CANCELLATION_REQUESTED'] as const;
export type IntentType = (typeof IntentTypes)[number];

/** Spec 3 `Destination`. `DriverAssigned` carries only the location, so the address may be missing. */
export interface Destination {
  address?: string;
  location: GeoLocation;
}

export interface RejectedIntent {
  type: IntentType;
  reason: string;
  at: string;
}

/** A location older than this makes `trackingAvailable` false (spec 3: "location age >= 300 s"). */
export const TRACKING_STALE_AFTER_SECONDS = 300;

/**
 * The view as stored (Redis hash, or archive snapshot). It is the spec's
 * `TrackingView` minus the read-time fields, plus what the service needs
 * internally: the owner (`customerId`, for the access check) and `revision`.
 */
export interface StoredTrackingView {
  orderId: string;
  /** Owner of the order, from `OrderCreated`. Never returned to the client. */
  customerId: string | null;
  /** null while only tracking/assignment events have arrived (events of one order travel on different topics). */
  status: OrderStatus | null;
  /** Order version (`aggregateVersion` of the last status event applied). */
  version: number;
  driverId: string | null;
  driverName: string | null;
  assignmentStatus: AssignmentStatus;
  destination: Destination | null;
  lastLocation: GeoLocation | null;
  lastLocationDeviceTime: string | null;
  lastSequence: number | null;
  nearbyReached: boolean;
  lastRejectedIntent: RejectedIntent | null;
  updatedAt: string;
  /**
   * Increases by one on EVERY change of the view (status, location,
   * assignment, NEARBY). It is the SSE event id ("view version", spec 4.4):
   * a location update changes the view but not the order version.
   */
  revision: number;
}

/** Spec 3 `TrackingView`: the body of `GET /tracking/{orderId}` and of each SSE event. */
export interface TrackingView {
  orderId: string;
  status: OrderStatus;
  version: number;
  driverId: string | null;
  driverName: string | null;
  assignmentStatus: AssignmentStatus;
  destination: Destination | null;
  lastLocation: GeoLocation | null;
  lastLocationDeviceTime: string | null;
  lastSequence: number | null;
  locationAgeSeconds: number | null;
  trackingAvailable: boolean;
  nearbyReached: boolean;
  lastRejectedIntent: RejectedIntent | null;
  updatedAt: string;
}

/** A stored view is only visible once its order is known (`OrderCreated` or a later status event). */
export function isVisible(view: StoredTrackingView | null): view is StoredTrackingView & { status: OrderStatus } {
  return view !== null && view.status !== null;
}

/**
 * Seconds since the device time of the last location, or null without location.
 * A device clock slightly ahead of the server gives 0, never a negative age.
 */
export function locationAgeSeconds(deviceTime: string | null, now: Date): number | null {
  if (!deviceTime) return null;
  const time = Date.parse(deviceTime);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 1000));
}

/**
 * Builds the API view. `trackingAvailable` is true only with a location less
 * than 5 minutes old (F3-S2); without location, or with an older one, it is
 * false and the app shows "Tracking temporarily unavailable" (F3-S3). The
 * status is copied as stored: staleness never changes it.
 */
export function toTrackingView(stored: StoredTrackingView & { status: OrderStatus }, now: Date): TrackingView {
  const age = locationAgeSeconds(stored.lastLocationDeviceTime, now);
  return {
    orderId: stored.orderId,
    status: stored.status,
    version: stored.version,
    driverId: stored.driverId,
    driverName: stored.driverName,
    assignmentStatus: stored.assignmentStatus,
    destination: stored.destination,
    lastLocation: stored.lastLocation,
    lastLocationDeviceTime: stored.lastLocationDeviceTime,
    lastSequence: stored.lastSequence,
    locationAgeSeconds: age,
    trackingAvailable: age !== null && age < TRACKING_STALE_AFTER_SECONDS,
    nearbyReached: stored.nearbyReached,
    lastRejectedIntent: stored.lastRejectedIntent,
    updatedAt: stored.updatedAt,
  };
}

/** The caller, as far as the access rule cares (same shape as `@libs/auth` AuthenticatedUser). */
export interface Viewer {
  userId: string;
  roles: readonly string[];
}

/**
 * Spec 4.4: `CUSTOMER` (owner) or `OPERATIONS`. A customer asking for
 * another customer's order is refused (403 in the HTTP adapter).
 */
export function canView(viewer: Viewer, view: Pick<StoredTrackingView, 'customerId'>): boolean {
  if (viewer.roles.includes('OPERATIONS')) return true;
  return viewer.roles.includes('CUSTOMER') && view.customerId !== null && view.customerId === viewer.userId;
}
