/**
 * Integration tests of the Profiles & Assignment Service against a REAL
 * PostgreSQL: migrations, the SQL store, the advisory locks, the partial
 * unique index and the outbox rows, driven through the real use cases.
 *
 * Needs `TEST_DATABASE_URL` (skipped otherwise), e.g. with the local stack:
 *
 *   $env:TEST_DATABASE_URL = "postgres://profiles_db:fasttrack@localhost:5432/profiles_db"
 *   npm run test:e2e
 *
 * Everything runs in a throw-away schema (`profiles_it_<random>`) that is
 * dropped at the end, so the service's own tables are never touched.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OUTBOX_ENTITIES, OutboxService } from '@libs/outbox';
import { PROFILES_MIGRATIONS } from '../src/adapters/out/persistence/persistence.module.js';
import { PostgresProfilesStore } from '../src/adapters/out/persistence/postgres-profiles.store.js';
import { AssignmentWindow } from '../src/domain/assignment-window.js';
import {
  Assigner,
  RetryDueAssignments,
  StartAssignment,
  TrackOrderStatus,
} from '../src/application/assignment.use-cases.js';
import { SaveCustomerProfile } from '../src/application/customer-profile.use-cases.js';
import {
  ChangeDriverAvailability,
  ChangeDriverCapacity,
  GetAssignment,
  SaveDriverProfile,
} from '../src/application/driver-profile.use-cases.js';
import { ConflictError } from '../src/application/errors.js';
import { AssignmentSettings } from '../src/application/ports.js';
import { FakeClock } from '../src/application/testing/in-memory.js';

const url = process.env.TEST_DATABASE_URL;
const DESTINATION = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};

interface OutboxRow {
  topic: string;
  message_key: string;
  envelope: {
    eventType: string;
    aggregateVersion: number | null;
    correlationId: string;
    payload: Record<string, unknown>;
  };
}

describe.skipIf(!url)('profiles-db (PostgreSQL)', () => {
  const schema = `profiles_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let store: PostgresProfilesStore;
  const clock = new FakeClock(new Date('2026-10-18T15:00:00Z'));
  let start: StartAssignment;
  let retry: RetryDueAssignments;
  let status: TrackOrderStatus;
  let availability: ChangeDriverAvailability;
  let capacity: ChangeDriverCapacity;
  let saveDriver: SaveDriverProfile;
  let saveCustomer: SaveCustomerProfile;
  let getAssignment: GetAssignment;

  const outbox = async (key?: string): Promise<OutboxRow[]> =>
    db.query(
      `SELECT topic, message_key, envelope FROM outbox ${key ? 'WHERE message_key = $1' : ''} ORDER BY id`,
      key ? [key] : [],
    );

  const orderCreated = (orderId = randomUUID()) =>
    start.execute({
      eventId: randomUUID(),
      correlationId: 'corr-order',
      orderId,
      customerId: randomUUID(),
      destination: DESTINATION,
      version: 1,
    });

  async function availableDriver(cap = 3): Promise<string> {
    const driverId = randomUUID();
    await saveDriver.execute(driverId, {
      name: 'Carlos Ruiz',
      phone: '+573109876543',
      vehiclePlate: 'ABC123',
    });
    if (cap !== 3) await capacity.execute(driverId, cap);
    await availability.execute(driverId, 'AVAILABLE', 'corr-driver');
    return driverId;
  }

  async function activeOrdersOf(driverId: string): Promise<string[]> {
    const rows: Array<{ order_id: string }> = await db.query(
      `SELECT order_id FROM assignments WHERE driver_id = $1 AND released_at IS NULL ORDER BY assigned_at, order_id`,
      [driverId],
    );
    return rows.map((row) => row.order_id);
  }

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url }).initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = await new DataSource({
      type: 'postgres',
      url,
      // Unqualified names in the migrations and the store resolve to the test schema.
      extra: { options: `-c search_path=${schema}` },
      entities: OUTBOX_ENTITIES,
      migrations: PROFILES_MIGRATIONS,
      migrationsRun: true,
    }).initialize();

    store = new PostgresProfilesStore(db, new OutboxService());
    const settings = new AssignmentSettings(new AssignmentWindow(30, 600), 3);
    const assigner = new Assigner(settings);
    start = new StartAssignment(store, assigner, clock);
    retry = new RetryDueAssignments(store, assigner, settings, clock);
    status = new TrackOrderStatus(store, assigner, clock);
    availability = new ChangeDriverAvailability(store, assigner, clock);
    capacity = new ChangeDriverCapacity(store);
    saveDriver = new SaveDriverProfile(store, settings, clock);
    saveCustomer = new SaveCustomerProfile(store, clock);
    getAssignment = new GetAssignment(store);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.destroy();
  });

  // Each test starts from empty tables, so drivers of one test never take orders of another.
  beforeEach(async () => {
    await db.query(
      `TRUNCATE assignments, assignment_requests, drivers, customers, processed_events, outbox`,
    );
  });

  it('runs the migrations: every table of profiles-db exists', async () => {
    const rows: Array<{ table_name: string }> = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'assignment_requests',
        'assignments',
        'customers',
        'drivers',
        'migrations',
        'outbox',
        'processed_events',
      ]),
    );
  });

  it('F1-S1: a new customer is stored and CustomerContactUpdated is in the outbox, in one transaction', async () => {
    const customerId = randomUUID();
    await saveCustomer.execute(
      customerId,
      { name: 'Laura', email: 'laura@example.com', phone: '+573001234567' },
      'corr-c',
    );

    const [row] = await outbox(customerId);
    expect(row).toMatchObject({
      topic: 'profile.events',
      message_key: customerId,
      envelope: {
        eventType: 'CustomerContactUpdated',
        aggregateVersion: 1,
        correlationId: 'corr-c',
        payload: { email: 'laura@example.com' },
      },
    });
  });

  it('concurrent PUTs of one customer never publish the same contact version', async () => {
    const customerId = randomUUID();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveCustomer.execute(
          customerId,
          { name: 'Laura', email: `laura${i}@example.com`, phone: null },
          'c',
        ),
      ),
    );

    const versions = (await outbox(customerId)).map(
      (row) => row.envelope.aggregateVersion,
    );
    expect(versions.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('F1-S2: OrderCreated with an available driver -> DriverAssigned with the destination location', async () => {
    const driverId = await availableDriver();
    const orderId = randomUUID();
    expect(await orderCreated(orderId)).toBe('ASSIGNED');

    const [row] = await outbox(orderId);
    expect(row).toMatchObject({
      topic: 'assignment.events',
      message_key: orderId,
      envelope: {
        eventType: 'DriverAssigned',
        correlationId: 'corr-order',
        payload: {
          orderId,
          driverId,
          driverName: 'Carlos Ruiz',
          destination: { location: DESTINATION.location },
        },
      },
    });
    expect(await getAssignment.execute(orderId)).toMatchObject({
      driverId,
      releasedAt: null,
    });
  });

  it('F1-S3: no driver -> retried by the scheduler once one is available', async () => {
    const orderId = randomUUID();
    expect(await orderCreated(orderId)).toBe('NO_DRIVER');
    const driverId = await availableDriver();

    expect((await retry.execute()).ASSIGNED).toBe(0); // not due before 30 s
    clock.advanceSeconds(30);
    expect((await retry.execute()).ASSIGNED).toBe(1);
    expect(await activeOrdersOf(driverId)).toEqual([orderId]);
  });

  it('F1-S3b: the window expires -> AssignmentFailed, order still CREATED', async () => {
    const orderId = randomUUID();
    await orderCreated(orderId);
    for (let i = 0; i < 20; i++) {
      clock.advanceSeconds(30);
      await retry.execute();
    }

    const types = (await outbox(orderId)).map((row) => row.envelope.eventType);
    expect(types).toEqual(['AssignmentFailed']);
    const [request] = await db.query(
      `SELECT state, order_status, attempts FROM assignment_requests WHERE order_id = $1`,
      [orderId],
    );
    expect(request).toEqual({
      state: 'FAILED',
      order_status: 'CREATED',
      attempts: 20,
    });
  });

  it('F1-S4: concurrent OrderCreated never exceed a driver capacity (assignment sessions are serialized)', async () => {
    const driverId = await availableDriver(2);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => orderCreated()),
    );

    expect(outcomes.filter((o) => o === 'ASSIGNED')).toHaveLength(2);
    expect(await activeOrdersOf(driverId)).toHaveLength(2);
  });

  it('a redelivered OrderCreated (same eventId) changes nothing', async () => {
    await availableDriver();
    const event = {
      eventId: randomUUID(),
      correlationId: 'c',
      orderId: randomUUID(),
      customerId: randomUUID(),
      destination: DESTINATION,
      version: 1,
    };

    await start.execute(event);
    expect(await start.execute(event)).toBe('DUPLICATE');
    expect(await outbox(event.orderId)).toHaveLength(1);
  });

  it('F1-S5: OrderDelivered releases the slot; the driver goes back to AVAILABLE', async () => {
    const driverId = await availableDriver();
    const orderId = randomUUID();
    await orderCreated(orderId);
    await status.execute({
      eventId: randomUUID(),
      eventType: 'OrderOnTheWay',
      orderId,
      status: 'ON_THE_WAY',
      version: 3,
      driverId,
    });
    await status.execute({
      eventId: randomUUID(),
      eventType: 'OrderDelivered',
      orderId,
      status: 'DELIVERED',
      version: 4,
      driverId,
    });

    const [driver] = await db.query(
      `SELECT availability FROM drivers WHERE driver_id = $1`,
      [driverId],
    );
    expect(driver.availability).toBe('AVAILABLE');
    expect(await getAssignment.execute(orderId)).toMatchObject({
      driverId,
      releasedAt: expect.any(Date),
      releaseReason: 'DELIVERED',
    });
  });

  it('F1-S6: OFFLINE releases CREATED orders (DriverUnassigned) and reassigns them; ON_THE_WAY blocks it', async () => {
    const first = await availableDriver();
    const orderId = randomUUID();
    await orderCreated(orderId); // -> first
    const second = await availableDriver();

    await availability.execute(first, 'OFFLINE', 'corr-off');
    const rows = await outbox(orderId);
    expect(rows.map((row) => row.envelope.eventType)).toEqual([
      'DriverAssigned',
      'DriverUnassigned',
      'DriverAssigned',
    ]);
    expect(rows[1].envelope).toMatchObject({
      correlationId: 'corr-off',
      payload: { driverId: first, reason: 'DRIVER_OFFLINE' },
    });
    expect(rows[2].envelope.payload).toMatchObject({ driverId: second });

    await status.execute({
      eventId: randomUUID(),
      eventType: 'OrderOnTheWay',
      orderId,
      status: 'ON_THE_WAY',
      version: 3,
      driverId: second,
    });
    await expect(
      availability.execute(second, 'OFFLINE', 'c'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await activeOrdersOf(second)).toEqual([orderId]);
  });

  it('the database refuses a second active assignment of the same order', async () => {
    const driverId = await availableDriver();
    const orderId = randomUUID();
    await orderCreated(orderId);

    await expect(
      db.query(
        `INSERT INTO assignments (order_id, driver_id, assigned_at) VALUES ($1, $2, now())`,
        [orderId, driverId],
      ),
    ).rejects.toThrow(/assignments_one_active_per_order_uq/);
  });

  it('a failed session rolls back everything, outbox included', async () => {
    await availableDriver();
    const orderId = randomUUID();
    await expect(
      store.inAssignmentSession(async (session) => {
        await session.publish({
          topic: 'assignment.events',
          key: orderId,
          envelope: { eventId: randomUUID() } as never,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await outbox(orderId)).toHaveLength(0);
  });
});
