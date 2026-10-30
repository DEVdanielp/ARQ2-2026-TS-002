/**
 * Use-case tests, named after the F2 and F5 scenarios of docs/spec.md section 6.
 */
import type { DriverNearDestinationPayload, GpsPoint, LocationUpdatedPayload } from '@libs/events';
import { ProcessGpsBatch } from './process-gps-batch.js';
import { AssignRouteOrder, TrackOrderStatus, UnassignRouteOrder } from './route-orders.use-cases.js';
import {
  FakeEtaProvider,
  InMemoryDriverTrackingStore,
  InMemoryRouteOrders,
  InMemoryTrackingDb,
  TEST_SETTINGS,
} from './testing/in-memory.js';

const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const ORDER = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
const OTHER_ORDER = '7a2d3c8f-0000-4000-8000-000000000002';
const DESTINATION = { lat: 6.2088, lng: -75.5679 };

/** A point `metersNorth` metres north of the destination. */
function point(sequence: number, metersNorth = 5_000): GpsPoint {
  return {
    lat: DESTINATION.lat + metersNorth / 111_195,
    lng: DESTINATION.lng,
    deviceTime: new Date(Date.UTC(2026, 9, 18, 15, 0, sequence)).toISOString(),
    sequence,
  };
}

function setup() {
  const db = new InMemoryTrackingDb();
  const eta = new FakeEtaProvider();
  eta.enabled = false;
  const store = new InMemoryDriverTrackingStore(db);
  const orders = new InMemoryRouteOrders(db);
  let batchNumber = 0;
  const processor = new ProcessGpsBatch(store, eta, TEST_SETTINGS);
  const process = (points: GpsPoint[], driverId = DRIVER) =>
    processor.execute({
      payload: { driverId, batchId: `batch-${++batchNumber}`, receivedAt: '2026-10-18T15:20:07Z', points },
      correlationId: 'corr-1',
    });
  return {
    db,
    eta,
    process,
    trackStatus: new TrackOrderStatus(orders),
    assign: new AssignRouteOrder(orders),
    unassign: new UnassignRouteOrder(orders),
  };
}

const storedSequences = (db: InMemoryTrackingDb) => db.points.map((p) => p.sequence);
const locationEvents = (db: InMemoryTrackingDb) =>
  db.eventsOf('LocationUpdated').map((m) => ({ key: m.key, topic: m.topic, ...(m.envelope.payload as LocationUpdatedPayload) }));
const nearbyEvents = (db: InMemoryTrackingDb) =>
  db.eventsOf('DriverNearDestination').map((m) => ({ key: m.key, topic: m.topic, ...(m.envelope.payload as DriverNearDestinationPayload) }));

describe('ProcessGpsBatch', () => {
  it('F2-S3: 50 points out of order are stored in sequence order; the location is the highest', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    const shuffled = Array.from({ length: 50 }, (_, i) => point(1001 + ((i * 17) % 50)));

    const result = await t.process(shuffled);

    expect(result).toMatchObject({ stored: 50, duplicates: 0, late: 0, lastSequence: 1050, locationMoved: true });
    expect(storedSequences(t.db)).toEqual(Array.from({ length: 50 }, (_, i) => 1001 + i));
    expect(t.db.routes.get(DRIVER)?.lastSequence).toBe(1050);
    // One LocationUpdated per monitored order, with the newest point, keyed by order.
    expect(locationEvents(t.db)).toEqual([
      expect.objectContaining({ topic: 'tracking.locations', key: ORDER, orderId: ORDER, driverId: DRIVER, sequence: 1050 }),
    ]);
  });

  it('F2-S4: a redelivered batch stores nothing, publishes nothing and keeps the location', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    const batch = [point(10), point(11)];
    await t.process(batch);

    const again = await t.process(batch);

    expect(again).toMatchObject({ stored: 0, duplicates: 2, locationMoved: false, lastSequence: 11 });
    expect(storedSequences(t.db)).toEqual([10, 11]);
    expect(locationEvents(t.db)).toHaveLength(1);
  });

  it('F2-S4: a late batch never moves the location backward, but its new points join the history', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    await t.process([point(20), point(21)]);

    const late = await t.process([point(18), point(19), point(21)]);

    expect(late).toMatchObject({ stored: 2, duplicates: 1, late: 2, locationMoved: false, lastSequence: 21 });
    expect(t.db.routes.get(DRIVER)?.lastLocation?.sequence).toBe(21);
    expect(storedSequences(t.db).sort((a, b) => a - b)).toEqual([18, 19, 20, 21]);
    expect(locationEvents(t.db).map((e) => e.sequence)).toEqual([21]);
  });

  it('F2-S5: points for a DELIVERED order are only stored; no event is published', async () => {
    const t = setup();
    await t.assign.execute('evt-assign', { orderId: ORDER, driverId: DRIVER, destination: DESTINATION }, 'corr');
    await t.trackStatus.execute({ orderId: ORDER, status: 'ON_THE_WAY', version: 3, driverId: DRIVER }, 'corr');
    await t.trackStatus.execute({ orderId: ORDER, status: 'DELIVERED', version: 4, driverId: DRIVER }, 'corr');

    const result = await t.process([point(1, 100)]);

    expect(result).toMatchObject({ stored: 1, locationMoved: true, locationUpdates: [], nearby: [] });
    expect(t.db.outbox).toHaveLength(0);
    expect(t.db.orders.get(ORDER)?.status).toBe('DELIVERED');
  });

  it('does not publish locations for an order that is assigned but not picked up yet', async () => {
    const t = setup();
    await t.assign.execute('evt-assign', { orderId: ORDER, driverId: DRIVER, destination: DESTINATION }, 'corr');

    await t.process([point(1, 100)]);

    expect(t.db.outbox).toHaveLength(0);
    expect(t.db.routes.get(DRIVER)?.lastSequence).toBe(1);
  });

  it('publishes one LocationUpdated per monitored order of the driver', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    t.db.addMonitoredOrder(OTHER_ORDER, DRIVER, { lat: 6.3, lng: -75.6 });
    t.db.addMonitoredOrder('8b3e4d9a-0000-4000-8000-000000000003', 'another-driver', DESTINATION);

    await t.process([point(1), point(2)]);

    expect(locationEvents(t.db).map((e) => e.orderId).sort()).toEqual([ORDER, OTHER_ORDER].sort());
  });

  it('keeps drivers independent: one driver\'s sequences do not affect another', async () => {
    const t = setup();
    await t.process([point(100)], DRIVER);

    const other = await t.process([point(5)], 'b0b0b0b0-0000-4000-8000-000000000000');

    expect(other).toMatchObject({ stored: 1, locationMoved: true, lastSequence: 5 });
  });

  it('rolls everything back if the transaction fails (nothing half-applied)', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    const store = new InMemoryDriverTrackingStore(t.db);
    const failing = new ProcessGpsBatch(
      {
        withDriver: (driverId, work) =>
          store.withDriver(driverId, async (session) => {
            await work(session);
            throw new Error('database went away before the commit');
          }),
        findMonitoredOrders: (driverId) => store.findMonitoredOrders(driverId),
      },
      t.eta,
      TEST_SETTINGS,
    );

    await expect(
      failing.execute({
        payload: { driverId: DRIVER, batchId: 'b', receivedAt: '2026-10-18T15:20:07Z', points: [point(1)] },
        correlationId: 'c',
      }),
    ).rejects.toThrow(/database went away/);

    expect(t.db.points).toHaveLength(0);
    expect(t.db.outbox).toHaveLength(0);
    expect(t.db.routes.get(DRIVER)).toBeUndefined();

    // The redelivery (Kafka retry) then applies it exactly once.
    await t.process([point(1)]);
    expect(storedSequences(t.db)).toEqual([1]);
    expect(locationEvents(t.db)).toHaveLength(1);
  });
});

describe('NEARBY (F5)', () => {
  it('F5-S1: a point under 500 m publishes DriverNearDestination once, keyed by order', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

    const result = await t.process([point(1, 2_000), point(2, 430)]);

    expect(result.nearby).toEqual([ORDER]);
    const [event] = nearbyEvents(t.db);
    expect(event).toMatchObject({
      topic: 'tracking.proximity',
      key: ORDER,
      orderId: ORDER,
      driverId: DRIVER,
      trigger: 'DISTANCE',
      distanceMeters: 430,
      etaSeconds: null,
      location: { lat: point(2, 430).lat, lng: DESTINATION.lng },
    });
    expect(t.db.orders.get(ORDER)).toMatchObject({ nearbyTrigger: 'DISTANCE', nearbyReachedAt: expect.any(Date) });
  });

  it('F5-S2: later points inside the zone do not publish a second NEARBY', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    await t.process([point(1, 400)]);

    await t.process([point(2, 300), point(3, 100)]);
    await t.process([point(4, 50)]);

    expect(nearbyEvents(t.db)).toHaveLength(1);
    expect(locationEvents(t.db)).toHaveLength(3);
  });

  it('a point near the destination in the middle of an offline backlog still triggers NEARBY', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

    await t.process([point(3, 900), point(1, 2_000), point(2, 450)]);

    expect(nearbyEvents(t.db).map((e) => e.distanceMeters)).toEqual([450]);
  });

  it('a late point near the destination does not trigger NEARBY (it is not the current position)', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    await t.process([point(10, 3_000)]);

    await t.process([point(5, 100), point(11, 2_500)]);

    expect(nearbyEvents(t.db)).toHaveLength(0);
  });

  describe('ETA (ADR-013)', () => {
    it('fires ETA when the provider says < 300 s, within 3 km', async () => {
      const t = setup();
      t.eta.enabled = true;
      t.eta.etaSeconds = 260;
      t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

      await t.process([point(1, 1_500)]);

      expect(t.eta.calls).toHaveLength(1);
      expect(nearbyEvents(t.db)).toEqual([expect.objectContaining({ trigger: 'ETA', etaSeconds: 260, distanceMeters: 1_500 })]);
    });

    it('does not call the provider beyond 3 km, inside 500 m, or after NEARBY', async () => {
      const t = setup();
      t.eta.enabled = true;
      t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

      await t.process([point(1, 3_500)]); // too far
      await t.process([point(2, 400)]); // distance decides; NEARBY fires
      await t.process([point(3, 1_000)]); // already NEARBY

      expect(t.eta.calls).toHaveLength(0);
      expect(nearbyEvents(t.db)).toHaveLength(1);
    });

    it('calls the provider at most once per minute per order', async () => {
      const t = setup();
      t.eta.enabled = true;
      t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

      await t.process([point(1, 2_000)]);
      await t.process([point(2, 1_900)]);

      expect(t.eta.calls).toHaveLength(1);
      expect(t.db.orders.get(ORDER)?.etaCheckedAt).toBeInstanceOf(Date);

      t.db.orders.get(ORDER)!.etaCheckedAt = new Date(Date.now() - 61_000);
      await t.process([point(3, 1_800)]);
      expect(t.eta.calls).toHaveLength(2);
    });

    it('falls back to distance when the provider fails, and still throttles it', async () => {
      const t = setup();
      t.eta.enabled = true;
      t.eta.failure = new Error('timeout');
      t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

      const result = await t.process([point(1, 1_500)]);
      await t.process([point(2, 1_400)]);

      expect(result).toMatchObject({ stored: 1, locationMoved: true, nearby: [] });
      expect(t.eta.calls).toHaveLength(1);
      await t.process([point(3, 200)]);
      expect(nearbyEvents(t.db)).toEqual([expect.objectContaining({ trigger: 'DISTANCE' })]);
    });
  });
});

describe('Monitored orders (events from other topics, any arrival order)', () => {
  it('starts monitoring after DriverAssigned + OrderOnTheWay, in either order', async () => {
    for (const order of [['assign', 'status'], ['status', 'assign']]) {
      const t = setup();
      for (const step of order) {
        if (step === 'assign') {
          await t.assign.execute('evt-a', { orderId: ORDER, driverId: DRIVER, destination: DESTINATION }, 'corr');
        } else {
          await t.trackStatus.execute({ orderId: ORDER, status: 'ON_THE_WAY', version: 3, driverId: DRIVER }, 'corr');
        }
      }
      await t.process([point(1)]);
      expect(locationEvents(t.db).map((e) => e.orderId)).toEqual([ORDER]);
    }
  });

  it('stops monitoring on OrderCancelled (saga compensation) and ignores a late OrderOnTheWay', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);
    await t.trackStatus.execute({ orderId: ORDER, status: 'CANCELLED', version: 4, driverId: DRIVER }, 'corr');

    expect(await t.trackStatus.execute({ orderId: ORDER, status: 'ON_THE_WAY', version: 3, driverId: DRIVER }, 'corr')).toBe(
      false,
    );
    await t.process([point(1)]);

    expect(t.db.orders.get(ORDER)?.status).toBe('CANCELLED');
    expect(t.db.outbox).toHaveLength(0);
  });

  it('ignores DriverAssigned for an order that is already terminal', async () => {
    const t = setup();
    await t.trackStatus.execute({ orderId: ORDER, status: 'CANCELLED', version: 2, driverId: null }, 'corr');

    expect(await t.assign.execute('evt-a', { orderId: ORDER, driverId: DRIVER, destination: DESTINATION }, 'corr')).toBe(
      'IGNORED_TERMINAL',
    );
    expect(t.db.orders.get(ORDER)?.driverId).toBeNull();
  });

  it('DriverUnassigned removes the order from the driver route only while CREATED and still theirs', async () => {
    const t = setup();
    await t.assign.execute('evt-a1', { orderId: ORDER, driverId: DRIVER, destination: DESTINATION }, 'corr');

    expect(await t.unassign.execute('evt-u0', { orderId: ORDER, driverId: 'someone-else' }, 'corr')).toBe('IGNORED');
    expect(await t.unassign.execute('evt-u1', { orderId: ORDER, driverId: DRIVER }, 'corr')).toBe('UNASSIGNED');
    expect(t.db.orders.get(ORDER)?.driverId).toBeNull();

    // Reassigned to another driver: the previous driver's points no longer reach the order.
    await t.assign.execute('evt-a2', { orderId: ORDER, driverId: 'c1c1c1c1-0000-4000-8000-000000000000', destination: DESTINATION }, 'corr');
    await t.trackStatus.execute({ orderId: ORDER, status: 'ON_THE_WAY', version: 3, driverId: null }, 'corr');
    await t.process([point(1)], DRIVER);
    expect(t.db.outbox).toHaveLength(0);
  });

  it('DriverUnassigned is ignored once the order is ON_THE_WAY', async () => {
    const t = setup();
    t.db.addMonitoredOrder(ORDER, DRIVER, DESTINATION);

    expect(await t.unassign.execute('evt-u', { orderId: ORDER, driverId: DRIVER }, 'corr')).toBe('IGNORED');
  });

  it('deduplicates assignment events by eventId', async () => {
    const t = setup();
    const assignment = { orderId: ORDER, driverId: DRIVER, destination: DESTINATION };

    expect(await t.assign.execute('evt-a', assignment, 'corr')).toBe('ASSIGNED');
    expect(await t.assign.execute('evt-a', assignment, 'corr')).toBe('DUPLICATE');
  });

  it('applies status by version: a duplicate or older status is ignored', async () => {
    const t = setup();
    const change = { orderId: ORDER, status: 'ON_THE_WAY' as const, version: 3, driverId: DRIVER };

    expect(await t.trackStatus.execute(change, 'corr')).toBe(true);
    expect(await t.trackStatus.execute(change, 'corr')).toBe(false);
  });
});
