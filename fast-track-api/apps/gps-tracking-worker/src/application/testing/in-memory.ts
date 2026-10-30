/**
 * In-memory implementations of the ports, for unit tests only.
 *
 * They follow the same rules as the PostgreSQL adapters (version guard,
 * terminal orders ignored, NEARBY set once, eventId deduplication) and also
 * the transaction: if the work throws, every change made through the session
 * is rolled back, events included.
 */
import type { GpsPoint } from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type { ProximityTrigger } from '../../domain/proximity.js';
import { isTerminal, type MonitoredOrder, type OrderStatus } from '../../domain/tracking.js';
import {
  DriverTrackingStore,
  EtaProvider,
  RouteOrderRepository,
  TrackingSettings,
  type AssignOutcome,
  type BatchInfo,
  type DriverAssignment,
  type DriverTrackingSession,
  type DriverUnassignment,
  type OrderStatusChange,
  type UnassignOutcome,
} from '../ports.js';

export interface StoredPoint extends GpsPoint {
  driverId: string;
  batchId: string;
  receivedAt: string;
}

export interface DriverRouteRow {
  lastSequence: number | null;
  lastLocation: GpsPoint | null;
  lastBatchId: string | null;
}

export interface RouteOrderRow {
  orderId: string;
  driverId: string | null;
  destination: { lat: number; lng: number } | null;
  status: OrderStatus;
  statusVersion: number;
  nearbyReachedAt: Date | null;
  nearbyTrigger: ProximityTrigger | null;
  etaCheckedAt: Date | null;
}

/** The whole tracking-db in memory. */
export class InMemoryTrackingDb {
  routes = new Map<string, DriverRouteRow>();
  points: StoredPoint[] = [];
  orders = new Map<string, RouteOrderRow>();
  processedEvents = new Set<string>();
  outbox: OutboxMessage[] = [];

  /** Deep copy for rollback (Dates survive structuredClone). */
  snapshot() {
    return structuredClone({
      routes: this.routes,
      points: this.points,
      orders: this.orders,
      processedEvents: this.processedEvents,
      outbox: this.outbox,
    });
  }

  restore(state: ReturnType<InMemoryTrackingDb['snapshot']>): void {
    Object.assign(this, state);
  }

  monitoredOrders(driverId: string): MonitoredOrder[] {
    return [...this.orders.values()]
      .filter((row) => row.driverId === driverId && row.status === 'ON_THE_WAY' && row.destination !== null)
      .sort((a, b) => a.orderId.localeCompare(b.orderId))
      .map((row) => ({
        orderId: row.orderId,
        driverId: driverId,
        destination: row.destination!,
        nearbyReachedAt: row.nearbyReachedAt,
        etaCheckedAt: row.etaCheckedAt,
      }));
  }

  /** Test helper: an order assigned and picked up, as after DriverAssigned + OrderOnTheWay. */
  addMonitoredOrder(orderId: string, driverId: string, destination: { lat: number; lng: number }): void {
    this.orders.set(orderId, {
      orderId,
      driverId,
      destination,
      status: 'ON_THE_WAY',
      statusVersion: 3,
      nearbyReachedAt: null,
      nearbyTrigger: null,
      etaCheckedAt: null,
    });
  }

  eventsOf(eventType: string) {
    return this.outbox.filter((message) => message.envelope.eventType === eventType);
  }
}

export class InMemoryDriverTrackingStore extends DriverTrackingStore {
  constructor(private readonly db: InMemoryTrackingDb) {
    super();
  }

  async withDriver<T>(driverId: string, work: (session: DriverTrackingSession) => Promise<T>): Promise<T> {
    const before = this.db.snapshot();
    const db = this.db;
    if (!db.routes.has(driverId)) db.routes.set(driverId, { lastSequence: null, lastLocation: null, lastBatchId: null });
    const route = db.routes.get(driverId)!;

    const session: DriverTrackingSession = {
      lastSequence: route.lastSequence,
      async findStoredSequences(sequences) {
        const wanted = new Set(sequences);
        return new Set(db.points.filter((p) => p.driverId === driverId && wanted.has(p.sequence)).map((p) => p.sequence));
      },
      async appendPoints(points: GpsPoint[], batch: BatchInfo) {
        db.points.push(...points.map((point) => ({ ...point, driverId, ...batch })));
      },
      async moveLocation(point: GpsPoint, batch: BatchInfo) {
        route.lastSequence = point.sequence;
        route.lastLocation = point;
        route.lastBatchId = batch.batchId;
      },
      async lockMonitoredOrders() {
        return db.monitoredOrders(driverId);
      },
      async markNearby(orderId, trigger, at) {
        const row = db.orders.get(orderId);
        if (!row || row.nearbyReachedAt) return false;
        row.nearbyReachedAt = at;
        row.nearbyTrigger = trigger;
        return true;
      },
      async recordEtaCheck(orderId, at) {
        const row = db.orders.get(orderId);
        if (row) row.etaCheckedAt = at;
      },
      async publish(message) {
        db.outbox.push(message);
      },
    };

    try {
      return await work(session);
    } catch (error) {
      this.db.restore(before);
      throw error;
    }
  }

  async findMonitoredOrders(driverId: string): Promise<MonitoredOrder[]> {
    return this.db.monitoredOrders(driverId);
  }
}

export class InMemoryRouteOrders extends RouteOrderRepository {
  constructor(private readonly db: InMemoryTrackingDb) {
    super();
  }

  private row(orderId: string): RouteOrderRow {
    let row = this.db.orders.get(orderId);
    if (!row) {
      row = {
        orderId,
        driverId: null,
        destination: null,
        status: 'CREATED',
        statusVersion: 0,
        nearbyReachedAt: null,
        nearbyTrigger: null,
        etaCheckedAt: null,
      };
      this.db.orders.set(orderId, row);
    }
    return row;
  }

  async applyStatus(change: OrderStatusChange): Promise<boolean> {
    const row = this.row(change.orderId);
    if (row.statusVersion >= change.version) return false;
    row.status = change.status;
    row.statusVersion = change.version;
    row.driverId ??= change.driverId;
    return true;
  }

  async assign(eventId: string, assignment: DriverAssignment): Promise<AssignOutcome> {
    if (this.db.processedEvents.has(eventId)) return 'DUPLICATE';
    this.db.processedEvents.add(eventId);
    const row = this.row(assignment.orderId);
    if (isTerminal(row.status)) return 'IGNORED_TERMINAL';
    row.driverId = assignment.driverId;
    row.destination = assignment.destination;
    row.etaCheckedAt = null;
    return 'ASSIGNED';
  }

  async unassign(eventId: string, unassignment: DriverUnassignment): Promise<UnassignOutcome> {
    if (this.db.processedEvents.has(eventId)) return 'DUPLICATE';
    this.db.processedEvents.add(eventId);
    const row = this.db.orders.get(unassignment.orderId);
    if (!row || row.driverId !== unassignment.driverId || row.status !== 'CREATED') return 'IGNORED';
    row.driverId = null;
    return 'UNASSIGNED';
  }
}

/** ETA provider whose answers the test controls. */
export class FakeEtaProvider extends EtaProvider {
  enabled = true;
  calls: Array<{ from: { lat: number; lng: number }; to: { lat: number; lng: number } }> = [];
  etaSeconds = 600;
  failure: Error | null = null;

  async estimateSeconds(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number> {
    this.calls.push({ from, to });
    if (this.failure) throw this.failure;
    return this.etaSeconds;
  }
}

/** The spec's thresholds: 500 m, 300 s; ADR-013: 3 km, 60 s. */
export const TEST_SETTINGS = new TrackingSettings(500, 300, 3_000, 60);
