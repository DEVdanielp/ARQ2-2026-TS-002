/**
 * Integration tests of the GPS Tracking Worker against a REAL PostgreSQL:
 * migrations, monthly partitions, the SQL repositories, row locks and the
 * outbox rows, driven through the real use cases.
 *
 * Needs `TEST_DATABASE_URL` (skipped otherwise), e.g. with the local stack:
 *
 *   $env:TEST_DATABASE_URL = "postgres://tracking_db:fasttrack@localhost:5432/tracking_db"
 *   npm run test:e2e
 *
 * Everything runs in a throw-away schema (`gps_it_<random>`) that is dropped at
 * the end, so the service's own tables are never touched.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { GpsPoint } from '@libs/events';
import { OUTBOX_ENTITIES, OutboxService } from '@libs/outbox';
import { GpsPointPartitions } from '../src/adapters/out/persistence/gps-point-partitions.js';
import { TRACKING_MIGRATIONS } from '../src/adapters/out/persistence/persistence.module.js';
import { PostgresDriverTrackingStore, PostgresRouteOrderRepository } from '../src/adapters/out/persistence/repositories.js';
import { ProcessGpsBatch } from '../src/application/process-gps-batch.js';
import { TrackingSettings } from '../src/application/ports.js';
import { DistanceOnlyEtaProvider } from '../src/adapters/out/eta/eta-providers.js';

const url = process.env.TEST_DATABASE_URL;
const DESTINATION = { lat: 6.2088, lng: -75.5679 };

function point(sequence: number, metersNorth = 5_000, deviceTime?: string): GpsPoint {
  return {
    lat: DESTINATION.lat + metersNorth / 111_195,
    lng: DESTINATION.lng,
    deviceTime: deviceTime ?? new Date(Date.now() - 60_000 + sequence).toISOString(),
    sequence,
    accuracyMeters: 7,
  };
}

describe.skipIf(!url)('tracking-db (PostgreSQL)', () => {
  const schema = `gps_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let processor: ProcessGpsBatch;
  let orders: PostgresRouteOrderRepository;

  const process = (driverId: string, points: GpsPoint[]) =>
    processor.execute({
      payload: { driverId, batchId: randomUUID(), receivedAt: new Date().toISOString(), points },
      correlationId: randomUUID(),
    });

  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params))[0].count);

  /** A driver with one order assigned and picked up (DriverAssigned + OrderOnTheWay). */
  async function monitoredOrder(driverId: string): Promise<string> {
    const orderId = randomUUID();
    expect(await orders.assign(randomUUID(), { orderId, driverId, destination: DESTINATION })).toBe('ASSIGNED');
    expect(await orders.applyStatus({ orderId, status: 'ON_THE_WAY', version: 3, driverId })).toBe(true);
    return orderId;
  }

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = await new DataSource({
      type: 'postgres',
      url,
      // Unqualified names in the migrations and repositories resolve to the test schema.
      extra: { options: `-c search_path=${schema}` },
      entities: OUTBOX_ENTITIES,
      migrations: TRACKING_MIGRATIONS,
      migrationsTableName: 'migrations',
    }).initialize();
    await db.runMigrations();
    await new GpsPointPartitions(db).ensure();

    const outbox = new OutboxService();
    processor = new ProcessGpsBatch(
      new PostgresDriverTrackingStore(db, outbox),
      new DistanceOnlyEtaProvider(),
      new TrackingSettings(500, 300, 3_000, 60),
    );
    orders = new PostgresRouteOrderRepository(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.destroy();
  });

  it('migrations create the tables and the monthly partitions', async () => {
    const tables: Array<{ tablename: string }> = await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [schema],
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toEqual(expect.arrayContaining(['driver_routes', 'route_orders', 'gps_points', 'gps_points_default', 'processed_events', 'outbox']));
    expect(names.filter((name) => /^gps_points_y\d{4}m\d{2}$/.test(name))).toHaveLength(4);

    // Running the maintenance again is harmless.
    await new GpsPointPartitions(db).ensure();
  });

  it('F2-S3: 50 shuffled points are stored once each; location = highest; one LocationUpdated in the outbox', async () => {
    const driverId = randomUUID();
    const orderId = await monitoredOrder(driverId);
    const shuffled = Array.from({ length: 50 }, (_, i) => point(1001 + ((i * 17) % 50)));

    const result = await process(driverId, shuffled);

    expect(result).toMatchObject({ stored: 50, duplicates: 0, lastSequence: 1050, locationMoved: true });
    expect(await count(`SELECT count(*) FROM gps_points WHERE driver_id = $1`, [driverId])).toBe(50);
    const [route] = await db.query(`SELECT last_sequence, last_lat FROM driver_routes WHERE driver_id = $1`, [driverId]);
    expect(Number(route.last_sequence)).toBe(1050);
    const outbox: Array<{ topic: string; message_key: string; envelope: { payload: { sequence: number } } }> = await db.query(
      `SELECT topic, message_key, envelope FROM outbox WHERE message_key = $1`,
      [orderId],
    );
    expect(outbox).toEqual([expect.objectContaining({ topic: 'tracking.locations', message_key: orderId })]);
    expect(outbox[0].envelope.payload.sequence).toBe(1050);
  });

  it('F2-S4: redelivery stores nothing new; a late batch stores its new points but keeps the location', async () => {
    const driverId = randomUUID();
    await process(driverId, [point(20), point(21)]);

    expect(await process(driverId, [point(20), point(21)])).toMatchObject({ stored: 0, duplicates: 2, locationMoved: false });
    expect(await process(driverId, [point(18), point(21)])).toMatchObject({ stored: 1, duplicates: 1, late: 1, locationMoved: false });

    const sequences: Array<{ sequence: string }> = await db.query(
      `SELECT sequence FROM gps_points WHERE driver_id = $1 ORDER BY sequence`,
      [driverId],
    );
    expect(sequences.map((row) => Number(row.sequence))).toEqual([18, 20, 21]);
    const [route] = await db.query(`SELECT last_sequence FROM driver_routes WHERE driver_id = $1`, [driverId]);
    expect(Number(route.last_sequence)).toBe(21);
  });

  it('serialises concurrent batches of one driver (row lock): no duplicates, location = max', async () => {
    const driverId = randomUUID();
    const first = Array.from({ length: 10 }, (_, i) => point(i + 1));
    const second = Array.from({ length: 11 }, (_, i) => point(i + 5));

    await Promise.all([process(driverId, first), process(driverId, second), process(driverId, first)]);

    expect(await count(`SELECT count(*) FROM gps_points WHERE driver_id = $1`, [driverId])).toBe(15);
    const [route] = await db.query(`SELECT last_sequence FROM driver_routes WHERE driver_id = $1`, [driverId]);
    expect(Number(route.last_sequence)).toBe(15);
  });

  it('F5-S1/S2: NEARBY is enqueued once per order, however many points fall inside the zone', async () => {
    const driverId = randomUUID();
    const orderId = await monitoredOrder(driverId);

    await process(driverId, [point(1, 2_000), point(2, 430)]);
    await process(driverId, [point(3, 200)]);

    expect(
      await count(`SELECT count(*) FROM outbox WHERE topic = 'tracking.proximity' AND message_key = $1`, [orderId]),
    ).toBe(1);
    const [row] = await db.query(`SELECT nearby_trigger FROM route_orders WHERE order_id = $1`, [orderId]);
    expect(row.nearby_trigger).toBe('DISTANCE');
  });

  it('F2-S5: points after OrderDelivered are stored, but nothing is published', async () => {
    const driverId = randomUUID();
    const orderId = await monitoredOrder(driverId);
    expect(await orders.applyStatus({ orderId, status: 'DELIVERED', version: 4, driverId })).toBe(true);

    expect(await process(driverId, [point(1, 100)])).toMatchObject({ stored: 1, locationUpdates: [], nearby: [] });
    expect(await count(`SELECT count(*) FROM outbox WHERE message_key = $1`, [orderId])).toBe(0);
  });

  it('order replication: version guard, terminal orders, unassignment and eventId deduplication', async () => {
    const driverId = randomUUID();
    const orderId = randomUUID();
    const assignEvent = randomUUID();

    expect(await orders.assign(assignEvent, { orderId, driverId, destination: DESTINATION })).toBe('ASSIGNED');
    expect(await orders.assign(assignEvent, { orderId, driverId, destination: DESTINATION })).toBe('DUPLICATE');
    expect(await orders.unassign(randomUUID(), { orderId, driverId: randomUUID() })).toBe('IGNORED');
    expect(await orders.unassign(randomUUID(), { orderId, driverId })).toBe('UNASSIGNED');

    expect(await orders.applyStatus({ orderId, status: 'CANCELLED', version: 2, driverId: null })).toBe(true);
    expect(await orders.applyStatus({ orderId, status: 'ON_THE_WAY', version: 2, driverId })).toBe(false);
    expect(await orders.assign(randomUUID(), { orderId, driverId, destination: DESTINATION })).toBe('IGNORED_TERMINAL');

    const [row] = await db.query(`SELECT status, status_version, driver_id FROM route_orders WHERE order_id = $1`, [orderId]);
    expect(row).toEqual({ status: 'CANCELLED', status_version: 2, driver_id: null });
  });

  it('a device time outside the monthly partitions lands in the DEFAULT partition instead of failing', async () => {
    const driverId = randomUUID();

    await process(driverId, [point(1, 5_000, '2031-01-01T00:00:00Z')]);

    expect(await count(`SELECT count(*) FROM gps_points_default WHERE driver_id = $1`, [driverId])).toBe(1);
  });

  it('the database rejects invalid data even if a bug let it through', async () => {
    await expect(
      db.query(
        `INSERT INTO gps_points (driver_id, sequence, lat, lng, device_time, batch_id, received_at)
         VALUES ($1, -1, 0, 0, now(), $2, now())`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
