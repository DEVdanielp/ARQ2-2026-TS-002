/**
 * Integration tests of the Orders Service against a REAL PostgreSQL:
 * migrations, the SQL store, row and advisory locks, the database constraints
 * and the outbox rows, driven through the real use cases.
 *
 * Needs `TEST_DATABASE_URL` (skipped otherwise), e.g. with the local stack:
 *
 *   $env:TEST_DATABASE_URL = "postgres://orders_db:fasttrack@localhost:5432/orders_db"
 *   npm run test:e2e
 *
 * Everything runs in a throw-away schema (`orders_it_<random>`) that is
 * dropped at the end, so the service's own tables are never touched.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OUTBOX_ENTITIES, OutboxService } from '@libs/outbox';
import { ORDERS_MIGRATIONS } from '../src/adapters/out/persistence/persistence.module.js';
import { PostgresOrdersStore } from '../src/adapters/out/persistence/postgres-orders.store.js';
import {
  CreateOrder,
  ListOrders,
  SubmitIntent,
} from '../src/application/orders.use-cases.js';
import {
  ApplyIntent,
  PurgeExpired,
  RecordDriverAssigned,
} from '../src/application/state-engine.use-cases.js';
import {
  FakeClock,
  FakeIntentPublisher,
} from '../src/application/testing/in-memory.js';

const url = process.env.TEST_DATABASE_URL;
const DESTINATION = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};
const CORRELATION = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';

describe.skipIf(!url)('orders-db (real PostgreSQL)', () => {
  const schema = `orders_it_${randomUUID().replaceAll('-', '')}`;
  let dataSource: DataSource;
  let store: PostgresOrdersStore;
  const clock = new FakeClock();

  const create = () => new CreateOrder(store, clock);
  const apply = () => new ApplyIntent(store, clock);
  const assigned = () => new RecordDriverAssigned(store, clock);

  const newOrderCommand = (customerId = randomUUID()) => ({
    customerId,
    destination: DESTINATION,
    correlationId: CORRELATION,
  });

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', url });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.destroy();

    dataSource = new DataSource({
      type: 'postgres',
      url,
      schema,
      extra: { options: `-c search_path=${schema}` },
      entities: [...OUTBOX_ENTITIES],
      migrations: ORDERS_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    store = new PostgresOrdersStore(dataSource, new OutboxService());
  });

  afterAll(async () => {
    await dataSource?.query(`DROP SCHEMA ${schema} CASCADE`);
    await dataSource?.destroy();
  });

  it('commits the order and OrderCreated together', async () => {
    const order = await create().execute(newOrderCommand());

    const stored = await store.findOrder(order.orderId);
    expect(stored).toMatchObject({
      status: 'CREATED',
      version: 1,
      destination: DESTINATION,
    });
    const rows = await dataSource.query(
      `SELECT topic, envelope FROM outbox WHERE message_key = $1`,
      [order.orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('orders.events');
    expect(rows[0].envelope).toMatchObject({
      eventType: 'OrderCreated',
      aggregateVersion: 1,
    });
  });

  it('rolls everything back when a step fails', async () => {
    const orderId = randomUUID();
    await expect(
      store.inSession(async (session) => {
        await session.insertOrder({
          orderId,
          customerId: randomUUID(),
          driverId: null,
          destination: DESTINATION,
          notes: null,
          status: 'CREATED',
          version: 1,
          cancellation: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.findOrder(orderId)).toBeNull();
  });

  it('runs the saga: assigned, picked up, delivered, with increasing versions', async () => {
    const order = await create().execute(newOrderCommand());
    const driverId = randomUUID();

    await assigned().execute({
      eventId: randomUUID(),
      eventType: 'DriverAssigned',
      orderId: order.orderId,
      driverId,
    });
    for (const [type, eventType] of [
      ['PICKUP_CONFIRMED', 'PickupConfirmed'],
      ['DELIVERY_CONFIRMED', 'DeliveryConfirmed'],
    ] as const) {
      await apply().execute({
        intentId: randomUUID(),
        eventType,
        orderId: order.orderId,
        intent: { type, actor: 'DRIVER', actorId: driverId },
        correlationId: CORRELATION,
      });
    }

    expect(await store.findOrder(order.orderId)).toMatchObject({
      status: 'DELIVERED',
      version: 4,
      driverId,
    });
    const events = await dataSource.query(
      `SELECT envelope->>'eventType' AS type, (envelope->>'aggregateVersion')::int AS version
         FROM outbox WHERE message_key = $1 ORDER BY id`,
      [order.orderId],
    );
    expect(events).toEqual([
      { type: 'OrderCreated', version: 1 },
      { type: 'OrderOnTheWay', version: 3 },
      { type: 'OrderDelivered', version: 4 },
    ]);
  });

  it('F4-S7: applies the same intent once, even when delivered at the same time', async () => {
    const order = await create().execute(newOrderCommand());
    const driverId = randomUUID();
    await assigned().execute({
      eventId: randomUUID(),
      eventType: 'DriverAssigned',
      orderId: order.orderId,
      driverId,
    });
    const delivery = {
      intentId: randomUUID(),
      eventType: 'PickupConfirmed',
      orderId: order.orderId,
      intent: {
        type: 'PICKUP_CONFIRMED' as const,
        actor: 'DRIVER' as const,
        actorId: driverId,
      },
      correlationId: CORRELATION,
    };

    const outcomes = await Promise.all([
      apply().execute(delivery),
      apply().execute(delivery),
    ]);

    expect(outcomes.sort()).toEqual(['applied', 'duplicate']);
    expect((await store.findOrder(order.orderId))?.version).toBe(3);
  });

  it('records a rejected intent and its event, without touching the order', async () => {
    const order = await create().execute(newOrderCommand());
    const intentId = randomUUID();

    await expect(
      apply().execute({
        intentId,
        eventType: 'PickupConfirmed',
        orderId: order.orderId,
        intent: {
          type: 'PICKUP_CONFIRMED',
          actor: 'DRIVER',
          actorId: randomUUID(),
        },
        correlationId: CORRELATION,
      }),
    ).resolves.toBe('rejected');

    const rows = await dataSource.query(
      `SELECT type, actor FROM rejected_intents WHERE intent_id = $1`,
      [intentId],
    );
    expect(rows).toEqual([{ type: 'PICKUP_CONFIRMED', actor: 'DRIVER' }]);
    expect((await store.findOrder(order.orderId))?.version).toBe(1);
  });

  it('two parallel requests with one key create one order', async () => {
    const command = {
      ...newOrderCommand(),
      idempotencyKey: randomUUID(),
    };

    const [first, second] = await Promise.all([
      create().execute(command),
      create().execute(command),
    ]);

    expect(second).toEqual(first);
    const rows = await dataSource.query(
      `SELECT count(*)::int AS total FROM orders WHERE customer_id = $1`,
      [command.customerId],
    );
    expect(rows[0].total).toBe(1);
  });

  it('a key is free again once expired, and the cleanup removes it', async () => {
    const localClock = new FakeClock();
    const command = {
      ...newOrderCommand(),
      idempotencyKey: randomUUID(),
    };
    const creator = new CreateOrder(store, localClock);

    const first = await creator.execute(command);
    localClock.advance(24 * 60 * 60 * 1000);
    const second = await creator.execute(command);
    expect(second.orderId).not.toBe(first.orderId);

    localClock.advance(24 * 60 * 60 * 1000);
    await new PurgeExpired(store, localClock).execute();
    const rows = await dataSource.query(
      `SELECT count(*)::int AS total FROM idempotency_keys WHERE owner_id = $1`,
      [command.customerId],
    );
    expect(rows[0].total).toBe(0);
  });

  it('a repeated intent key publishes once', async () => {
    const order = await create().execute(newOrderCommand());
    const driverId = randomUUID();
    await assigned().execute({
      eventId: randomUUID(),
      eventType: 'DriverAssigned',
      orderId: order.orderId,
      driverId,
    });
    const publisher = new FakeIntentPublisher();
    const submit = new SubmitIntent(store, publisher, clock);
    const command = {
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED' as const,
      caller: { userId: driverId, roles: ['DRIVER'] },
      idempotencyKey: randomUUID(),
      correlationId: CORRELATION,
    };

    const first = await submit.execute(command);
    const second = await submit.execute(command);

    expect(second).toEqual(first);
    expect(publisher.published).toHaveLength(1);
  });

  it('lists by owner, either role, status and page', async () => {
    const customerId = randomUUID();
    const first = await create().execute(newOrderCommand(customerId));
    await create().execute(newOrderCommand(customerId));
    const list = new ListOrders(store);

    const mine = await list.execute(
      { userId: customerId, roles: ['CUSTOMER'] },
      { page: 0, size: 1 },
    );
    expect(mine.total).toBe(2);
    expect(mine.items).toHaveLength(1);

    const driverId = randomUUID();
    await assigned().execute({
      eventId: randomUUID(),
      eventType: 'DriverAssigned',
      orderId: first.orderId,
      driverId,
    });
    const assignedToDriver = await list.execute(
      { userId: driverId, roles: ['DRIVER'] },
      { status: 'CREATED', page: 0, size: 20 },
    );
    expect(assignedToDriver.items.map((order) => order.orderId)).toEqual([
      first.orderId,
    ]);
  });

  it('the database refuses a cancellation by operations without a reason', async () => {
    const order = await create().execute(newOrderCommand());
    await expect(
      dataSource.query(
        `UPDATE orders SET status = 'CANCELLED', cancellation_actor = 'OPERATIONS' WHERE order_id = $1`,
        [order.orderId],
      ),
    ).rejects.toThrow(/operations_cancellation_has_reason/);
  });
});
