/**
 * Test doubles of every port, for unit tests of the use cases.
 *
 * The view store does NOT re-implement the version/sequence guards: those live
 * in the Lua script (ADR-010) and are tested against a real Redis in
 * test/tracking-cache.e2e-spec.ts. Here the store records what it was asked to
 * apply and answers what the test tells it to.
 */
import type { StoredTrackingView } from '../../domain/tracking-view.js';
import type { ViewChange } from '../../domain/view-change.js';
import {
  Clock,
  TrackingArchive,
  TrackingViewStore,
  ViewChangeBus,
  type ArchivedRoutePoint,
  type OrderRoute,
  type TimeRange,
} from '../ports.js';

export class FakeTrackingViewStore extends TrackingViewStore {
  readonly views = new Map<string, StoredTrackingView>();
  readonly applied: ViewChange[] = [];
  /** What the next `apply` calls return. */
  applyResult = true;
  /** When set, `get` throws it (Redis down). */
  getError: Error | null = null;

  async apply(change: ViewChange): Promise<boolean> {
    this.applied.push(change);
    return this.applyResult;
  }

  async get(orderId: string): Promise<StoredTrackingView | null> {
    if (this.getError) throw this.getError;
    return this.views.get(orderId) ?? null;
  }
}

export class InMemoryTrackingArchive extends TrackingArchive {
  readonly snapshots = new Map<string, StoredTrackingView>();
  readonly points: ArchivedRoutePoint[] = [];
  lastRange: TimeRange | null = null;

  async saveSnapshot(view: StoredTrackingView): Promise<void> {
    const current = this.snapshots.get(view.orderId);
    if (!current || current.revision < view.revision) this.snapshots.set(view.orderId, view);
  }

  async findSnapshot(orderId: string): Promise<StoredTrackingView | null> {
    return this.snapshots.get(orderId) ?? null;
  }

  async appendRoutePoint(point: ArchivedRoutePoint): Promise<void> {
    const duplicate = this.points.some((p) => p.orderId === point.orderId && p.sequence === point.sequence);
    if (!duplicate) this.points.push(point);
  }

  async findRoute(orderId: string, range: TimeRange): Promise<OrderRoute | null> {
    this.lastRange = range;
    const all = this.points.filter((p) => p.orderId === orderId);
    if (all.length === 0 && !this.snapshots.has(orderId)) return null;
    const points = all
      .filter((p) => (!range.from || new Date(p.deviceTime) >= range.from) && (!range.to || new Date(p.deviceTime) <= range.to))
      .sort((a, b) => a.sequence - b.sequence);
    return {
      orderId,
      driverId: points.at(-1)?.driverId ?? this.snapshots.get(orderId)?.driverId ?? null,
      points: points.map((p) => ({ lat: p.location.lat, lng: p.location.lng, deviceTime: p.deviceTime, sequence: p.sequence })),
    };
  }
}

export class InMemoryViewChangeBus extends ViewChangeBus {
  readonly published: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  async publish(orderId: string): Promise<void> {
    this.published.push(orderId);
    for (const listener of this.listeners.get(orderId) ?? []) listener();
  }

  subscribe(orderId: string, listener: () => void): () => void {
    const set = this.listeners.get(orderId) ?? new Set();
    set.add(listener);
    this.listeners.set(orderId, set);
    return () => set.delete(listener);
  }

  listenerCount(orderId: string): number {
    return this.listeners.get(orderId)?.size ?? 0;
  }
}

export class FixedClock extends Clock {
  constructor(public current: Date) {
    super();
  }

  now(): Date {
    return this.current;
  }
}

/** A complete stored view with sensible defaults. */
export function storedView(overrides: Partial<StoredTrackingView> = {}): StoredTrackingView {
  return {
    orderId: '6f1c2b7e-0000-4000-8000-000000000001',
    customerId: '3c9f8a2e-0000-4000-8000-000000000001',
    status: 'ON_THE_WAY',
    version: 3,
    driverId: '9a1b2c3d-0000-4000-8000-000000000001',
    driverName: 'Carlos Ruiz',
    assignmentStatus: 'ASSIGNED',
    destination: { address: 'Cra 43A #1-50, Medellín', location: { lat: 6.2088, lng: -75.5679 } },
    lastLocation: { lat: 6.2439, lng: -75.5807 },
    lastLocationDeviceTime: '2026-10-18T15:20:06Z',
    lastSequence: 1042,
    nearbyReached: false,
    lastRejectedIntent: null,
    updatedAt: '2026-10-18T15:20:07Z',
    revision: 5,
    ...overrides,
  };
}
