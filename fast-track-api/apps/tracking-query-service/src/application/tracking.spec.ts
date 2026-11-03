/**
 * Use-case tests, named after the F3 scenarios of docs/spec.md section 6.
 */
import {
  InvalidRouteRangeError,
  OrderAccessDeniedError,
  OrderNotFoundError,
  TrackingCacheUnavailableError,
} from './errors.js';
import { GetOrderRoute } from './get-route.js';
import { GetTrackingView, type TrackingViewResult } from './get-tracking-view.js';
import { ProjectTrackingEvent } from './project-tracking-event.js';
import {
  FakeTrackingViewStore,
  FixedClock,
  InMemoryTrackingArchive,
  InMemoryViewChangeBus,
  storedView,
} from './testing/in-memory.js';
import { WatchTrackingView } from './watch-tracking-view.js';

const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';
const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const OWNER = { userId: CUSTOMER, roles: ['CUSTOMER'] };
const OPS = { userId: 'ops-1', roles: ['OPERATIONS'] };

function setup() {
  const views = new FakeTrackingViewStore();
  const archive = new InMemoryTrackingArchive();
  const bus = new InMemoryViewChangeBus();
  const clock = new FixedClock(new Date('2026-10-18T15:24:06Z'));
  const getView = new GetTrackingView(views, archive, clock);
  return {
    views,
    archive,
    bus,
    clock,
    project: new ProjectTrackingEvent(views, archive, bus),
    getView,
    watch: new WatchTrackingView(getView, bus),
    getRoute: new GetOrderRoute(archive),
  };
}

describe('ProjectTrackingEvent', () => {
  it('applies a status change, snapshots the view and notifies the streams', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView());

    const changed = await t.project.execute({ kind: 'status', orderId: ORDER, status: 'ON_THE_WAY', version: 3 });

    expect(changed).toBe(true);
    expect(t.views.applied).toHaveLength(1);
    expect(t.archive.snapshots.get(ORDER)?.revision).toBe(5);
    expect(t.bus.published).toEqual([ORDER]);
  });

  it('F3-S4: a stale status (version not higher) changes nothing and notifies nobody', async () => {
    const t = setup();
    t.views.applyResult = false;
    t.views.views.set(ORDER, storedView());

    expect(await t.project.execute({ kind: 'status', orderId: ORDER, status: 'ON_THE_WAY', version: 2 })).toBe(false);
    expect(t.bus.published).toEqual([]);
  });

  it('still writes the snapshot on a redelivery, in case the first attempt died before it', async () => {
    const t = setup();
    t.views.applyResult = false;
    t.views.views.set(ORDER, storedView({ status: 'DELIVERED', version: 4 }));

    await t.project.execute({ kind: 'status', orderId: ORDER, status: 'DELIVERED', version: 4 });

    expect(t.archive.snapshots.get(ORDER)?.status).toBe('DELIVERED');
  });

  it('does not snapshot a view whose order is still unknown', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ status: null }));

    await t.project.execute({ kind: 'nearby', orderId: ORDER });

    expect(t.archive.snapshots.size).toBe(0);
  });

  it('archives every location for the route audit, without snapshotting the view', async () => {
    const t = setup();
    t.views.applyResult = false; // e.g. a late sequence: the view does not move
    t.views.views.set(ORDER, storedView());

    await t.project.execute({
      kind: 'location',
      orderId: ORDER,
      driverId: DRIVER,
      location: { lat: 6.25, lng: -75.58 },
      deviceTime: '2026-10-18T15:20:00Z',
      sequence: 1000,
    });

    expect(t.archive.points).toHaveLength(1);
    expect(t.archive.snapshots.size).toBe(0);
    expect(t.bus.published).toEqual([]);
  });
});

describe('GetTrackingView', () => {
  it('F3-S1: serves an active order from Redis without asking the archive', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView());
    const findSnapshot = vi.spyOn(t.archive, 'findSnapshot');

    const { view, revision } = await t.getView.execute(ORDER, OWNER);

    expect(view).toMatchObject({ orderId: ORDER, status: 'ON_THE_WAY', locationAgeSeconds: 240, trackingAvailable: true });
    expect(revision).toBe(5);
    expect(findSnapshot).not.toHaveBeenCalled();
  });

  it('F3-S5: after the 24 h expiry the view is served from the archive', async () => {
    const t = setup();
    t.archive.snapshots.set(ORDER, storedView({ status: 'DELIVERED', version: 4 }));

    const { view } = await t.getView.execute(ORDER, OWNER);

    expect(view.status).toBe('DELIVERED');
  });

  it('404 when neither Redis nor the archive know the order', async () => {
    await expect(setup().getView.execute(ORDER, OWNER)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('404 while only tracking events have arrived (no OrderCreated yet)', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ status: null }));
    await expect(t.getView.execute(ORDER, OWNER)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("403 for another customer's order; operations may read any order", async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView());
    await expect(t.getView.execute(ORDER, { userId: 'someone-else', roles: ['CUSTOMER'] })).rejects.toBeInstanceOf(
      OrderAccessDeniedError,
    );
    await expect(t.getView.execute(ORDER, OPS)).resolves.toBeDefined();
  });

  it('propagates Redis being down (503), without falling back to the archive', async () => {
    const t = setup();
    t.views.getError = new TrackingCacheUnavailableError(new Error('ECONNREFUSED'));
    t.archive.snapshots.set(ORDER, storedView());
    await expect(t.getView.execute(ORDER, OWNER)).rejects.toBeInstanceOf(TrackingCacheUnavailableError);
  });
});

describe('WatchTrackingView (SSE)', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('sends the current view, then every newer revision', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ revision: 5 }));
    const sent: TrackingViewResult[] = [];

    const stop = await t.watch.start({ orderId: ORDER, viewer: OWNER, lastEventId: null, send: (e) => sent.push(e) });
    t.views.views.set(ORDER, storedView({ revision: 6, nearbyReached: true }));
    await t.bus.publish(ORDER);
    await flush();

    expect(sent.map((e) => e.revision)).toEqual([5, 6]);
    expect(sent[1].view.nearbyReached).toBe(true);
    stop();
    expect(t.bus.listenerCount(ORDER)).toBe(0);
  });

  it('on reconnection skips the current view if Last-Event-ID is already that revision', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ revision: 5 }));
    const sent: TrackingViewResult[] = [];

    await t.watch.start({ orderId: ORDER, viewer: OWNER, lastEventId: 5, send: (e) => sent.push(e) });

    expect(sent).toEqual([]);
  });

  it('on reconnection sends the current view if it is newer than Last-Event-ID', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ revision: 9 }));
    const sent: TrackingViewResult[] = [];

    await t.watch.start({ orderId: ORDER, viewer: OWNER, lastEventId: 5, send: (e) => sent.push(e) });

    expect(sent.map((e) => e.revision)).toEqual([9]);
  });

  it('never sends an older or repeated revision', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView({ revision: 5 }));
    const sent: TrackingViewResult[] = [];
    await t.watch.start({ orderId: ORDER, viewer: OWNER, lastEventId: null, send: (e) => sent.push(e) });

    await t.bus.publish(ORDER); // same revision
    await flush();

    expect(sent.map((e) => e.revision)).toEqual([5]);
  });

  it('refuses access before streaming and leaves no subscription behind', async () => {
    const t = setup();
    t.views.views.set(ORDER, storedView());
    await expect(
      t.watch.start({ orderId: ORDER, viewer: { userId: 'x', roles: ['CUSTOMER'] }, lastEventId: null, send: () => {} }),
    ).rejects.toBeInstanceOf(OrderAccessDeniedError);
    expect(t.bus.listenerCount(ORDER)).toBe(0);
  });
});

describe('GetOrderRoute', () => {
  function withPoints() {
    const t = setup();
    for (const [sequence, deviceTime] of [
      [1042, '2026-10-18T15:20:06Z'],
      [1041, '2026-10-18T15:20:01Z'],
      [1043, '2026-10-18T15:20:11Z'],
    ] as const) {
      t.archive.points.push({ orderId: ORDER, driverId: DRIVER, location: { lat: 6.24, lng: -75.58 }, deviceTime, sequence });
    }
    return t;
  }

  it('returns the points ordered by sequence, with the driver', async () => {
    const route = await withPoints().getRoute.execute(ORDER);
    expect(route.driverId).toBe(DRIVER);
    expect(route.points.map((p) => p.sequence)).toEqual([1041, 1042, 1043]);
  });

  it('filters by device time', async () => {
    const route = await withPoints().getRoute.execute(ORDER, '2026-10-18T15:20:05Z', '2026-10-18T15:20:10Z');
    expect(route.points.map((p) => p.sequence)).toEqual([1042]);
  });

  it('400 for an invalid date or an inverted range', async () => {
    const t = withPoints();
    await expect(t.getRoute.execute(ORDER, 'yesterday')).rejects.toBeInstanceOf(InvalidRouteRangeError);
    await expect(t.getRoute.execute(ORDER, '2026-10-18T15:20:00')).rejects.toBeInstanceOf(InvalidRouteRangeError);
    await expect(t.getRoute.execute(ORDER, '2026-10-18T16:00:00Z', '2026-10-18T15:00:00Z')).rejects.toBeInstanceOf(
      InvalidRouteRangeError,
    );
  });

  it('404 for an order the archive does not know', async () => {
    await expect(setup().getRoute.execute(ORDER)).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});
