/**
 * Integration tests of the archive against a REAL PostgreSQL: the migration
 * and the SQL of PostgresTrackingArchive (snapshots by revision, idempotent
 * route points, route filtering).
 *
 * Needs `TEST_ARCHIVE_DATABASE_URL` (skipped otherwise), e.g. with the local stack:
 *
 *   $env:TEST_ARCHIVE_DATABASE_URL = "postgres://query_archive_db:fasttrack@localhost:5432/query_archive_db"
 *   npm run test:e2e
 *
 * Everything runs in a throw-away schema (`archive_it_<random>`) that is
 * dropped at the end, so the service's own tables are never touched.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ARCHIVE_MIGRATIONS } from '../src/adapters/out/persistence/persistence.module.js';
import { PostgresTrackingArchive } from '../src/adapters/out/persistence/postgres-tracking-archive.js';
import { storedView } from '../src/application/testing/in-memory.js';

const url = process.env.TEST_ARCHIVE_DATABASE_URL;
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';

describe.skipIf(!url)('query-archive-db (PostgreSQL)', () => {
  const schema = `archive_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let archive: PostgresTrackingArchive;

  const point = (orderId: string, sequence: number, deviceTime: string) =>
    archive.appendRoutePoint({ orderId, driverId: DRIVER, location: { lat: 6.24, lng: -75.58 }, deviceTime, sequence });

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = await new DataSource({
      type: 'postgres',
      url,
      // Unqualified names in the migration and the archive resolve to the test schema.
      extra: { options: `-c search_path=${schema}` },
      migrations: ARCHIVE_MIGRATIONS,
      migrationsTableName: 'migrations',
    }).initialize();
    await db.runMigrations();
    archive = new PostgresTrackingArchive(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.destroy();
  });

  it('keeps the snapshot with the highest revision', async () => {
    const orderId = randomUUID();
    await archive.saveSnapshot(storedView({ orderId, status: 'ON_THE_WAY', revision: 5 }));
    await archive.saveSnapshot(storedView({ orderId, status: 'DELIVERED', version: 4, revision: 8 }));
    await archive.saveSnapshot(storedView({ orderId, status: 'ON_THE_WAY', revision: 6 })); // late

    expect(await archive.findSnapshot(orderId)).toMatchObject({ orderId, status: 'DELIVERED', version: 4, revision: 8 });
    expect(await archive.findSnapshot(randomUUID())).toBeNull();
  });

  it('stores each (order, sequence) once and returns the route ordered by sequence', async () => {
    const orderId = randomUUID();
    await point(orderId, 1042, '2026-10-18T15:20:06Z');
    await point(orderId, 1041, '2026-10-18T15:20:01Z');
    await point(orderId, 1042, '2026-10-18T15:20:06Z'); // redelivery

    const route = await archive.findRoute(orderId, {});
    expect(route).toEqual({
      orderId,
      driverId: DRIVER,
      points: [
        { lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T15:20:01.000Z', sequence: 1041 },
        { lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T15:20:06.000Z', sequence: 1042 },
      ],
    });
  });

  it('filters by device time; an empty range of a known order is an empty route, not a 404', async () => {
    const orderId = randomUUID();
    await point(orderId, 1, '2026-10-18T15:00:00Z');
    await point(orderId, 2, '2026-10-18T15:10:00Z');

    const inRange = await archive.findRoute(orderId, {
      from: new Date('2026-10-18T15:05:00Z'),
      to: new Date('2026-10-18T15:15:00Z'),
    });
    expect(inRange?.points.map((p) => p.sequence)).toEqual([2]);

    const empty = await archive.findRoute(orderId, { from: new Date('2026-10-19T00:00:00Z') });
    expect(empty).toEqual({ orderId, driverId: DRIVER, points: [] });
  });

  it('an order with only a snapshot has an empty route with its driver', async () => {
    const orderId = randomUUID();
    await archive.saveSnapshot(storedView({ orderId, driverId: DRIVER }));
    expect(await archive.findRoute(orderId, {})).toEqual({ orderId, driverId: DRIVER, points: [] });
  });

  it('null for an order the archive does not know', async () => {
    expect(await archive.findRoute(randomUUID(), {})).toBeNull();
  });
});
