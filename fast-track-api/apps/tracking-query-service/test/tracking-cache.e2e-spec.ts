/**
 * Integration tests of the read model against a REAL Redis: the Lua script of
 * ADR-010 (version / sequence guards, terminal expiry) and the Pub/Sub fan-out
 * of ADR-004, driven through the real adapters.
 *
 * Needs `TEST_REDIS_URL` (skipped otherwise), e.g. with the local stack:
 *
 *   $env:TEST_REDIS_URL = "redis://localhost:6379/15"
 *   npm run test:e2e
 *
 * Use a spare database number (15): every test uses fresh random order ids,
 * and their keys are deleted at the end.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisTrackingViewStore, viewKey } from '../src/adapters/out/redis/redis-tracking-view.store.js';
import { RedisViewChangeBus } from '../src/adapters/out/redis/redis-view-change.bus.js';
import { TrackingQuerySettings } from '../src/application/ports.js';
import type { ViewChange } from '../src/domain/view-change.js';

const url = process.env.TEST_REDIS_URL;
const TTL_SECONDS = 86_400;
const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const OTHER_DRIVER = '9a1b2c3d-0000-4000-8000-000000000002';
const DESTINATION = { address: 'Cra 43A #1-50, Medellín', location: { lat: 6.2088, lng: -75.5679 } };

describe.skipIf(!url)('tracking-cache (Redis)', () => {
  let redis: Redis;
  let store: RedisTrackingViewStore;
  const used: string[] = [];

  const newOrder = () => {
    const orderId = randomUUID();
    used.push(orderId);
    return orderId;
  };
  const apply = (change: ViewChange) => store.apply(change);
  const created = (orderId: string) =>
    apply({ kind: 'status', orderId, status: 'CREATED', version: 1, customerId: CUSTOMER, destination: DESTINATION });
  const location = (orderId: string, sequence: number, lat = 6.24) =>
    apply({
      kind: 'location',
      orderId,
      driverId: DRIVER,
      location: { lat, lng: -75.58 },
      deviceTime: `2026-10-18T15:20:${String(sequence % 60).padStart(2, '0')}Z`,
      sequence,
    });

  beforeAll(async () => {
    redis = new Redis(url!, { lazyConnect: true });
    await redis.connect();
    store = new RedisTrackingViewStore(redis, new TrackingQuerySettings(TTL_SECONDS));
  });

  afterAll(async () => {
    if (used.length) await redis.del(...used.map(viewKey));
    await redis?.quit();
  });

  it('OrderCreated creates the view: CREATED, owner, destination, assignment PENDING, no expiry', async () => {
    const orderId = newOrder();
    expect(await created(orderId)).toBe(true);

    const view = await store.get(orderId);
    expect(view).toMatchObject({
      orderId,
      customerId: CUSTOMER,
      status: 'CREATED',
      version: 1,
      assignmentStatus: 'PENDING',
      destination: DESTINATION,
      nearbyReached: false,
      revision: 1,
    });
    expect(await redis.ttl(viewKey(orderId))).toBe(-1);
  });

  it('F3-S4: a status with a version lower or equal to the stored one does not modify the view', async () => {
    const orderId = newOrder();
    await created(orderId);
    expect(await apply({ kind: 'status', orderId, status: 'DELIVERED', version: 4 })).toBe(true);

    // Late OrderOnTheWay (v3) and a duplicate OrderDelivered (v4).
    expect(await apply({ kind: 'status', orderId, status: 'ON_THE_WAY', version: 3 })).toBe(false);
    expect(await apply({ kind: 'status', orderId, status: 'DELIVERED', version: 4 })).toBe(false);

    expect(await store.get(orderId)).toMatchObject({ status: 'DELIVERED', version: 4, revision: 2 });
  });

  it('F3-S5: a terminal status sets the 24 h expiry', async () => {
    const orderId = newOrder();
    await created(orderId);
    await apply({ kind: 'status', orderId, status: 'CANCELLED', version: 2 });

    const ttl = await redis.ttl(viewKey(orderId));
    expect(ttl).toBeGreaterThan(TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(TTL_SECONDS);
  });

  it('events tolerate any arrival order: a location before OrderCreated is kept', async () => {
    const orderId = newOrder();
    expect(await location(orderId, 10)).toBe(true);
    expect((await store.get(orderId))?.status).toBeNull();

    await created(orderId);
    expect(await store.get(orderId)).toMatchObject({ status: 'CREATED', lastSequence: 10 });
  });

  it('a location moves the view only with a higher sequence', async () => {
    const orderId = newOrder();
    await created(orderId);
    expect(await location(orderId, 1042, 6.2439)).toBe(true);
    expect(await location(orderId, 1041, 6.2442)).toBe(false); // late
    expect(await location(orderId, 1042, 6.2442)).toBe(false); // duplicate

    const view = await store.get(orderId);
    expect(view).toMatchObject({ lastSequence: 1042, lastLocation: { lat: 6.2439, lng: -75.58 }, status: 'CREATED' });
    expect(view?.lastLocationDeviceTime).toBe('2026-10-18T15:20:22Z');
  });

  it('nothing but a higher status changes a terminal view (locations, NEARBY, assignment)', async () => {
    const orderId = newOrder();
    await created(orderId);
    await apply({ kind: 'status', orderId, status: 'DELIVERED', version: 4 });

    expect(await location(orderId, 5)).toBe(false);
    expect(await apply({ kind: 'nearby', orderId })).toBe(false);
    expect(await apply({ kind: 'assigned', orderId, driverId: DRIVER, at: Date.now() })).toBe(false);
    expect(await store.get(orderId)).toMatchObject({ status: 'DELIVERED', lastSequence: null, nearbyReached: false });
  });

  it('NEARBY is set once', async () => {
    const orderId = newOrder();
    await created(orderId);
    expect(await apply({ kind: 'nearby', orderId })).toBe(true);
    expect(await apply({ kind: 'nearby', orderId })).toBe(false);
    expect((await store.get(orderId))?.nearbyReached).toBe(true);
  });

  it('assignment: assigned -> unassigned -> failed, ignoring stale redeliveries', async () => {
    const orderId = newOrder();
    await created(orderId);
    const t0 = Date.parse('2026-10-18T15:01:10Z');

    expect(
      await apply({
        kind: 'assigned',
        orderId,
        driverId: DRIVER,
        driverName: 'Carlos Ruiz',
        destination: { location: { lat: 1, lng: 1 } },
        at: t0,
      }),
    ).toBe(true);
    // The DriverAssigned destination does not replace the full one from OrderCreated.
    expect(await store.get(orderId)).toMatchObject({
      driverId: DRIVER,
      driverName: 'Carlos Ruiz',
      assignmentStatus: 'ASSIGNED',
      destination: DESTINATION,
    });

    // Unassign of another driver: ignored.
    expect(await apply({ kind: 'unassigned', orderId, driverId: OTHER_DRIVER, at: t0 + 1000 })).toBe(false);
    expect(await apply({ kind: 'unassigned', orderId, driverId: DRIVER, at: t0 + 1000 })).toBe(true);
    expect(await store.get(orderId)).toMatchObject({ driverId: null, driverName: null, assignmentStatus: 'PENDING' });

    // A redelivered (older) DriverAssigned does not bring the driver back.
    expect(await apply({ kind: 'assigned', orderId, driverId: DRIVER, at: t0 })).toBe(false);

    expect(await apply({ kind: 'failed', orderId, at: t0 + 600_000 })).toBe(true);
    expect(await store.get(orderId)).toMatchObject({ assignmentStatus: 'FAILED', status: 'CREATED' });
  });

  it('DriverUnassigned is ignored once the order is ON_THE_WAY', async () => {
    const orderId = newOrder();
    await created(orderId);
    await apply({ kind: 'assigned', orderId, driverId: DRIVER, at: 1 });
    await apply({ kind: 'status', orderId, status: 'ON_THE_WAY', version: 3, driverId: DRIVER });

    expect(await apply({ kind: 'unassigned', orderId, driverId: DRIVER, at: 2 })).toBe(false);
    expect((await store.get(orderId))?.driverId).toBe(DRIVER);
  });

  it('OrderOnTheWay fills the driver when DriverAssigned has not arrived yet', async () => {
    const orderId = newOrder();
    await created(orderId);
    await apply({ kind: 'status', orderId, status: 'ON_THE_WAY', version: 3, driverId: DRIVER });
    expect(await store.get(orderId)).toMatchObject({ driverId: DRIVER, assignmentStatus: 'ASSIGNED' });
  });

  it('get returns null for an unknown order', async () => {
    expect(await store.get(randomUUID())).toBeNull();
  });

  it('Pub/Sub: a published change reaches the listeners of that order only', async () => {
    const bus = new RedisViewChangeBus(redis);
    await bus.onModuleInit();
    try {
      const orderId = newOrder();
      const received: string[] = [];
      const stop = bus.subscribe(orderId, () => received.push(orderId));
      bus.subscribe(randomUUID(), () => received.push('other'));

      await bus.publish(orderId);
      await expect.poll(() => received, { timeout: 2_000 }).toEqual([orderId]);

      stop();
      await bus.publish(orderId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([orderId]);
    } finally {
      await bus.onModuleDestroy();
    }
  });
});
