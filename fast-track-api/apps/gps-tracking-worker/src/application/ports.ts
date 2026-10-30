/**
 * Ports: what the use cases need from the outside world (ADR-014).
 *
 * The application layer declares these abstract classes; the adapters
 * implement them (PostgreSQL through TypeORM, an HTTP ETA provider). Use cases
 * depend only on these declarations, so they are tested with in-memory fakes
 * (application/testing/in-memory.ts).
 *
 * They are abstract classes (not interfaces) because Nest needs a runtime
 * token to inject an implementation.
 */
import type { GeoLocation, GpsPoint } from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type { ProximityTrigger } from '../domain/proximity.js';
import type { Coordinates, MonitoredOrder, OrderStatus } from '../domain/tracking.js';

// ---------------------------------------------------------------- driver tracking (gps.batches)

/** Batch metadata stored next to every point, for auditing. */
export interface BatchInfo {
  batchId: string;
  /** ISO-8601 time when the GPS Ingestion API received the batch. */
  receivedAt: string;
}

/**
 * What a use case may do with ONE driver's tracking state, inside one
 * database transaction that holds the driver's lock. Everything done through
 * a session commits together, or not at all, including the events (outbox).
 */
export interface DriverTrackingSession {
  /** Sequence of the driver's last known location; null if no point was ever stored. */
  readonly lastSequence: number | null;
  /** Which of these sequences the driver's history already contains. */
  findStoredSequences(sequences: number[]): Promise<Set<number>>;
  /** Appends points to the append-only history (gps_points). */
  appendPoints(points: GpsPoint[], batch: BatchInfo): Promise<void>;
  /** Moves the last known location to this point. */
  moveLocation(point: GpsPoint, batch: BatchInfo): Promise<void>;
  /** The driver's monitored orders (ON_THE_WAY, with destination), locked until commit. */
  lockMonitoredOrders(): Promise<MonitoredOrder[]>;
  /** Sets the NEARBY flag if not set yet. @returns whether THIS call set it. */
  markNearby(orderId: string, trigger: ProximityTrigger, at: Date): Promise<boolean>;
  /** Records a call to the ETA provider for the order (throttling, ADR-013). */
  recordEtaCheck(orderId: string, at: Date): Promise<void>;
  /** Enqueues an event in the transactional outbox (ADR-005). */
  publish(message: OutboxMessage): Promise<void>;
}

export abstract class DriverTrackingStore {
  /**
   * Runs `work` in ONE transaction holding the driver's row lock (the row is
   * created on first use). Two batches of one driver never interleave, even
   * if two worker instances briefly own the same partition during a rebalance.
   */
  abstract withDriver<T>(driverId: string, work: (session: DriverTrackingSession) => Promise<T>): Promise<T>;
  /**
   * The driver's monitored orders, read WITHOUT a lock: used before the
   * transaction, to call the ETA provider without holding the lock (ADR-013).
   */
  abstract findMonitoredOrders(driverId: string): Promise<MonitoredOrder[]>;
}

// ---------------------------------------------------------------- monitored orders (orders.events, assignment.events)

/** A status event of the order (OrderOnTheWay, OrderDelivered, OrderCancelled). */
export interface OrderStatusChange {
  orderId: string;
  status: OrderStatus;
  /** The envelope's aggregateVersion: older or equal versions are ignored. */
  version: number;
  /** The payload's driverId, if any: fills the driver when DriverAssigned has not arrived yet. */
  driverId: string | null;
}

export interface DriverAssignment {
  orderId: string;
  driverId: string;
  /** Destination from DriverAssigned (spec 5.4), needed by the NEARBY rule. */
  destination: Coordinates;
}

export interface DriverUnassignment {
  orderId: string;
  driverId: string;
}

export type AssignOutcome = 'ASSIGNED' | 'IGNORED_TERMINAL' | 'DUPLICATE';
export type UnassignOutcome = 'UNASSIGNED' | 'IGNORED' | 'DUPLICATE';

export abstract class RouteOrderRepository {
  /**
   * Stores the status only if `version` is higher than the stored one, so a
   * late or duplicate event never moves an order backward (spec 5.4, ADR-009).
   * @returns whether the status was stored.
   */
  abstract applyStatus(change: OrderStatusChange): Promise<boolean>;
  /**
   * Adds the order to the driver's route, unless the order is already terminal
   * (spec 1, consistency rules). Deduplicated by eventId (spec 5.4).
   */
  abstract assign(eventId: string, assignment: DriverAssignment): Promise<AssignOutcome>;
  /**
   * Removes the order from the driver's route, only if it is still assigned to
   * that driver and still CREATED (spec 5.4 `DriverUnassigned`). Deduplicated by eventId.
   */
  abstract unassign(eventId: string, unassignment: DriverUnassignment): Promise<UnassignOutcome>;
}

// ---------------------------------------------------------------- Maps/ETA provider

export abstract class EtaProvider {
  /** false = distance-only mode: the provider is never called (ADR-013 fallback). */
  abstract readonly enabled: boolean;
  /**
   * Driving time in seconds from `from` to `to`.
   * @throws if the provider fails or times out; the caller falls back to distance.
   */
  abstract estimateSeconds(from: GeoLocation, to: GeoLocation): Promise<number>;
}

// ---------------------------------------------------------------- settings

/** Business settings read from the environment. */
export class TrackingSettings {
  constructor(
    /** NEARBY when closer than this (spec: 500 m). */
    readonly nearbyDistanceMeters: number,
    /** NEARBY when the ETA is below this (spec: 300 s). */
    readonly nearbyEtaSeconds: number,
    /** Only ask the ETA provider within this distance (ADR-013: 3 km). */
    readonly etaLookupRadiusMeters: number,
    /** At most one ETA call per order per this interval (ADR-013: 1 min). */
    readonly etaMinIntervalSeconds: number,
  ) {}
}
