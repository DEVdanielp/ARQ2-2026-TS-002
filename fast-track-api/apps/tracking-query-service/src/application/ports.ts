/**
 * Ports: what the use cases need from the outside world (ADR-014).
 *
 * Abstract classes (not interfaces) so Nest has a runtime token to inject:
 * `{ provide: TrackingViewStore, useClass: RedisTrackingViewStore }`.
 *
 * | Port               | Backed by                                  | Spec / ADR |
 * | ------------------ | ------------------------------------------ | ---------- |
 * | TrackingViewStore  | Redis hash `tracking:view:{orderId}` + Lua | ADR-002, ADR-010 |
 * | ViewChangeBus      | Redis Pub/Sub channel `tracking:changes`   | ADR-004 |
 * | TrackingArchive    | `query-archive-db` (PostgreSQL)            | spec 3 storage, F3-S5, 4.4 route |
 */
import type { GeoLocation } from '@libs/events';
import type { StoredTrackingView } from '../domain/tracking-view.js';
import type { ViewChange } from '../domain/view-change.js';

/** The per-order read model (tracking-cache). */
export abstract class TrackingViewStore {
  /**
   * Applies one change atomically, with the guards listed in
   * domain/view-change.ts (version, sequence, terminal status).
   *
   * @returns true if the view changed, false if the change was stale or a duplicate.
   */
  abstract apply(change: ViewChange): Promise<boolean>;

  /**
   * @returns the stored view, or null if the key does not exist (never
   *   created, or expired 24 h after a terminal status).
   * @throws {TrackingCacheUnavailableError} if Redis cannot be reached.
   */
  abstract get(orderId: string): Promise<StoredTrackingView | null>;
}

/**
 * Fans out "the view of order X changed" to every instance (ADR-004), so an
 * SSE stream held by instance B sees a change projected by instance A.
 * Fire-and-forget: a missed message is not replayed (the client reloads over
 * REST on reconnection).
 */
export abstract class ViewChangeBus {
  abstract publish(orderId: string): Promise<void>;

  /** Calls `listener` on every change of `orderId`. Returns the unsubscribe function. */
  abstract subscribe(orderId: string, listener: () => void): () => void;
}

/** One stored GPS point of an order's route (spec 3 `RoutePoint` + who drove it). */
export interface ArchivedRoutePoint {
  orderId: string;
  driverId: string;
  location: GeoLocation;
  deviceTime: string;
  sequence: number;
}

export interface RoutePoint {
  lat: number;
  lng: number;
  deviceTime: string;
  sequence: number;
}

/** Body of `GET /tracking/{orderId}/route` (spec 4.4). */
export interface OrderRoute {
  orderId: string;
  driverId: string | null;
  /** Ordered by `sequence`. */
  points: RoutePoint[];
}

export interface TimeRange {
  from?: Date;
  to?: Date;
}

/** query-archive-db: views of finished orders and the route audit. */
export abstract class TrackingArchive {
  /** Upserts the snapshot of a view, keeping the one with the highest `revision`. */
  abstract saveSnapshot(view: StoredTrackingView): Promise<void>;

  abstract findSnapshot(orderId: string): Promise<StoredTrackingView | null>;

  /** Idempotent: a `(orderId, sequence)` already stored is ignored. */
  abstract appendRoutePoint(point: ArchivedRoutePoint): Promise<void>;

  /** @returns null if the archive knows nothing about the order. */
  abstract findRoute(orderId: string, range: TimeRange): Promise<OrderRoute | null>;
}

/** Settings read from the environment (config/environment.ts). */
export class TrackingQuerySettings {
  constructor(
    /** Life of a terminal view in Redis (ADR-002: 24 h). */
    readonly terminalViewTtlSeconds: number,
    /** Interval of the SSE heartbeat comment (spec 4.4: 15 s). */
    readonly heartbeatSeconds: number = 15,
  ) {}
}

/** Wall clock, injectable so read-time rules can be tested at a fixed instant. */
export class Clock {
  now(): Date {
    return new Date();
  }
}
