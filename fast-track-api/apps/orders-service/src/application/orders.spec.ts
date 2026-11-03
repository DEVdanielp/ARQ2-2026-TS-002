/**
 * Use cases against in-memory ports: the scenarios of F4 and the saga steps
 * Orders owns (spec 1), without Kafka or PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { newOrder, type Order, type OrderStatus } from '../domain/order.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  ServiceUnavailableError,
  UnknownOrderError,
} from './errors.js';
import type { IntentPayload } from './events.js';
import { intentIdFor } from './idempotency.js';
import {
  CreateOrder,
  GetOrder,
  ListOrders,
  SubmitIntent,
} from './orders.use-cases.js';
import {
  ApplyIntent,
  PurgeExpired,
  RecordDriverAssigned,
  RecordDriverUnassigned,
} from './state-engine.use-cases.js';
import {
  FakeClock,
  FakeIntentPublisher,
  InMemoryOrdersStore,
} from './testing/in-memory.js';

const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const OTHER_CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000002';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const OTHER_DRIVER = '9a1b2c3d-0000-4000-8000-000000000002';
const OPS = '7b8c9d0e-0000-4000-8000-000000000001';
const CORRELATION = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';
const KEY = '1f6e0c2a-77b1-4d0e-9a8f-2b3c4d5e6f70';
const DESTINATION = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};

const customer = { userId: CUSTOMER, roles: ['CUSTOMER'] };
const driver = { userId: DRIVER, roles: ['DRIVER'] };
const operations = { userId: OPS, roles: ['OPERATIONS'] };

function setup() {
  const store = new InMemoryOrdersStore();
  const clock = new FakeClock();
  const publisher = new FakeIntentPublisher();
  return {
    store,
    clock,
    publisher,
    create: new CreateOrder(store, clock),
    get: new GetOrder(store),
    list: new ListOrders(store),
    submit: new SubmitIntent(store, publisher, clock),
    apply: new ApplyIntent(store, clock),
    assigned: new RecordDriverAssigned(store, clock),
    unassigned: new RecordDriverUnassigned(store, clock),
    purge: new PurgeExpired(store, clock),
  };
}

function seeded(
  store: InMemoryOrdersStore,
  status: OrderStatus = 'CREATED',
  driverId: string | null = DRIVER,
): Order {
  const order: Order = {
    ...newOrder({
      orderId: randomUUID(),
      customerId: CUSTOMER,
      destination: DESTINATION,
      notes: null,
      now: new Date('2026-10-18T14:00:00Z'),
    }),
    status,
    driverId,
    version: 2,
  };
  store.seed(order);
  return order;
}

/** Sends the published intent through the engine, as the Kafka consumer does. */
function engineInput(t: ReturnType<typeof setup>, index = 0) {
  const envelope = t.publisher.published[index];
  const payload = envelope.payload as IntentPayload;
  return {
    intentId: envelope.eventId,
    eventType: envelope.eventType,
    orderId: payload.orderId,
    intent: {
      type: payload.type,
      actor: payload.actor,
      actorId: payload.actorId,
      ...(payload.reason ? { reason: payload.reason } : {}),
    },
    correlationId: envelope.correlationId,
  };
}

describe('CreateOrder', () => {
  it('creates the order and enqueues OrderCreated with version 1', async () => {
    const t = setup();
    const order = await t.create.execute({
      customerId: CUSTOMER,
      destination: DESTINATION,
      notes: 'Leave at reception',
      correlationId: CORRELATION,
    });

    expect(order).toMatchObject({
      customerId: CUSTOMER,
      driverId: null,
      status: 'CREATED',
      version: 1,
      cancellation: null,
    });
    const [message] = t.store.eventsOfType('OrderCreated');
    expect(message).toMatchObject({
      topic: 'orders.events',
      key: order.orderId,
      envelope: {
        correlationId: CORRELATION,
        aggregateId: order.orderId,
        aggregateVersion: 1,
        producer: 'orders-service',
        payload: {
          orderId: order.orderId,
          customerId: CUSTOMER,
          status: 'CREATED',
          destination: DESTINATION,
        },
      },
    });
  });

  it('a repeated key returns the original response and creates nothing', async () => {
    const t = setup();
    const command = {
      customerId: CUSTOMER,
      destination: DESTINATION,
      idempotencyKey: KEY,
      correlationId: CORRELATION,
    };
    const first = await t.create.execute(command);
    const second = await t.create.execute(command);

    expect(second).toEqual(first);
    expect(t.store.eventsOfType('OrderCreated')).toHaveLength(1);
  });

  it('the same key with a different body is a 409', async () => {
    const t = setup();
    const command = {
      customerId: CUSTOMER,
      destination: DESTINATION,
      idempotencyKey: KEY,
      correlationId: CORRELATION,
    };
    await t.create.execute(command);

    await expect(
      t.create.execute({ ...command, notes: 'Another note' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('a key belongs to its user, and expires after 24 h', async () => {
    const t = setup();
    const command = {
      customerId: CUSTOMER,
      destination: DESTINATION,
      idempotencyKey: KEY,
      correlationId: CORRELATION,
    };
    const first = await t.create.execute(command);
    const other = await t.create.execute({
      ...command,
      customerId: OTHER_CUSTOMER,
    });
    expect(other.orderId).not.toBe(first.orderId);

    t.clock.advance(24 * 60 * 60 * 1000);
    const later = await t.create.execute(command);
    expect(later.orderId).not.toBe(first.orderId);
  });
});

describe('GetOrder', () => {
  it('returns the order to its owner', async () => {
    const t = setup();
    const order = seeded(t.store);
    await expect(t.get.execute(order.orderId, customer)).resolves.toMatchObject(
      { orderId: order.orderId, status: 'CREATED' },
    );
  });

  it('403 for a stranger, 404 for an unknown order', async () => {
    const t = setup();
    const order = seeded(t.store);
    await expect(
      t.get.execute(order.orderId, {
        userId: OTHER_CUSTOMER,
        roles: ['CUSTOMER'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.get.execute(randomUUID(), customer)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('ListOrders', () => {
  it('scopes the list by role, and filters by status', async () => {
    const t = setup();
    seeded(t.store, 'CREATED', DRIVER);
    seeded(t.store, 'ON_THE_WAY', OTHER_DRIVER);
    t.store.seed({
      ...seeded(t.store, 'CREATED', null),
      orderId: randomUUID(),
      customerId: OTHER_CUSTOMER,
    });

    const query = { page: 0, size: 20 };
    expect((await t.list.execute(operations, query)).total).toBe(4);
    expect((await t.list.execute(customer, query)).total).toBe(3);
    expect((await t.list.execute(driver, query)).total).toBe(1);
    expect(
      (await t.list.execute(operations, { ...query, status: 'ON_THE_WAY' }))
        .total,
    ).toBe(1);
  });

  it('paginates', async () => {
    const t = setup();
    seeded(t.store);
    seeded(t.store);
    seeded(t.store);

    const page = await t.list.execute(customer, { page: 1, size: 2 });
    expect(page).toMatchObject({ page: 1, size: 2, total: 3 });
    expect(page.items).toHaveLength(1);
  });
});

describe('SubmitIntent', () => {
  const base = { correlationId: CORRELATION };

  it('queues the intent and answers QUEUED; the order does not change yet', async () => {
    const t = setup();
    const order = seeded(t.store);
    const accepted = await t.submit.execute({
      ...base,
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED',
      caller: driver,
    });

    expect(accepted).toMatchObject({
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED',
      status: 'QUEUED',
    });
    const [envelope] = t.publisher.published;
    expect(envelope).toMatchObject({
      eventId: accepted.intentId,
      eventType: 'PickupConfirmed',
      aggregateId: order.orderId,
      correlationId: CORRELATION,
      payload: {
        intentId: accepted.intentId,
        actor: 'DRIVER',
        actorId: DRIVER,
      },
    });
    expect((await t.store.findOrder(order.orderId))?.status).toBe('CREATED');
  });

  it('F4-S4: 403 for a customer cancelling ON_THE_WAY; nothing is queued', async () => {
    const t = setup();
    const order = seeded(t.store, 'ON_THE_WAY');
    await expect(
      t.submit.execute({
        ...base,
        orderId: order.orderId,
        type: 'CANCELLATION_REQUESTED',
        caller: customer,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.publisher.published).toHaveLength(0);
  });

  it.each([undefined, '   '])(
    'F4-S5: 400 when operations gives no reason (%j)',
    async (reason) => {
      const t = setup();
      const order = seeded(t.store, 'ON_THE_WAY');
      await expect(
        t.submit.execute({
          ...base,
          orderId: order.orderId,
          type: 'CANCELLATION_REQUESTED',
          reason,
          caller: operations,
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    },
  );

  it('F4-S6: 409 for a terminal order', async () => {
    const t = setup();
    const order = seeded(t.store, 'DELIVERED');
    await expect(
      t.submit.execute({
        ...base,
        orderId: order.orderId,
        type: 'CANCELLATION_REQUESTED',
        reason: 'Too late',
        caller: operations,
      }),
    ).rejects.toMatchObject({ code: 'order-terminal' });
  });

  it('F4-S8: 403 for a driver who is no longer assigned', async () => {
    const t = setup();
    const order = seeded(t.store, 'CREATED', OTHER_DRIVER);
    await expect(
      t.submit.execute({
        ...base,
        orderId: order.orderId,
        type: 'PICKUP_CONFIRMED',
        caller: driver,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('404 for an unknown order', async () => {
    const t = setup();
    await expect(
      t.submit.execute({
        ...base,
        orderId: randomUUID(),
        type: 'PICKUP_CONFIRMED',
        caller: driver,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('503 when Kafka fails, and the key stays free for the retry', async () => {
    const t = setup();
    const order = seeded(t.store);
    const command = {
      ...base,
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED' as const,
      caller: driver,
      idempotencyKey: KEY,
    };
    t.publisher.failing = true;
    await expect(t.submit.execute(command)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    t.publisher.failing = false;
    await expect(t.submit.execute(command)).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('a repeated key returns the same intent and publishes once', async () => {
    const t = setup();
    const order = seeded(t.store);
    const command = {
      ...base,
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED' as const,
      caller: driver,
      idempotencyKey: KEY,
    };
    const first = await t.submit.execute(command);
    const second = await t.submit.execute(command);

    expect(second).toEqual(first);
    expect(t.publisher.published).toHaveLength(1);
  });

  it('derives the intentId from the key, as a valid UUID v4', () => {
    const scope = 'POST /orders/x/intents';
    const id = intentIdFor(DRIVER, scope, KEY);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(intentIdFor(DRIVER, scope, KEY)).toBe(id);
    expect(intentIdFor(OPS, scope, KEY)).not.toBe(id);
  });
});

describe('ApplyIntent (state engine)', () => {
  it('F4-S1 and F4-S2: pickup, then delivery, each with a higher version', async () => {
    const t = setup();
    const order = seeded(t.store);

    await t.submit.execute({
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED',
      caller: driver,
      correlationId: CORRELATION,
    });
    await expect(t.apply.execute(engineInput(t))).resolves.toBe('applied');

    await t.submit.execute({
      orderId: order.orderId,
      type: 'DELIVERY_CONFIRMED',
      caller: driver,
      correlationId: CORRELATION,
    });
    await expect(t.apply.execute(engineInput(t, 1))).resolves.toBe('applied');

    expect(await t.store.findOrder(order.orderId)).toMatchObject({
      status: 'DELIVERED',
      version: 4,
    });
    const [onTheWay] = t.store.eventsOfType('OrderOnTheWay');
    expect(onTheWay.envelope).toMatchObject({
      aggregateVersion: 3,
      correlationId: CORRELATION,
      payload: {
        status: 'ON_THE_WAY',
        previousStatus: 'CREATED',
        driverId: DRIVER,
      },
    });
    expect(t.store.eventsOfType('OrderDelivered')[0].envelope).toMatchObject({
      aggregateVersion: 4,
      payload: { status: 'DELIVERED', previousStatus: 'ON_THE_WAY' },
    });
  });

  it('F4-S5: operations cancels with the reason recorded in the event', async () => {
    const t = setup();
    const order = seeded(t.store, 'ON_THE_WAY');
    await t.submit.execute({
      orderId: order.orderId,
      type: 'CANCELLATION_REQUESTED',
      reason: 'Failed delivery: recipient unreachable',
      caller: operations,
      correlationId: CORRELATION,
    });
    await t.apply.execute(engineInput(t));

    expect(await t.store.findOrder(order.orderId)).toMatchObject({
      status: 'CANCELLED',
      cancellation: {
        actor: 'OPERATIONS',
        reason: 'Failed delivery: recipient unreachable',
      },
    });
    expect(t.store.eventsOfType('OrderCancelled')[0].envelope.payload).toEqual({
      orderId: order.orderId,
      status: 'CANCELLED',
      previousStatus: 'ON_THE_WAY',
      driverId: DRIVER,
      cancellation: {
        actor: 'OPERATIONS',
        reason: 'Failed delivery: recipient unreachable',
      },
      changedAt: t.clock.current.toISOString(),
    });
  });

  it('F4-S7: the same intent delivered twice is applied once', async () => {
    const t = setup();
    const order = seeded(t.store);
    await t.submit.execute({
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED',
      caller: driver,
      correlationId: CORRELATION,
    });

    await t.apply.execute(engineInput(t));
    await expect(t.apply.execute(engineInput(t))).resolves.toBe('duplicate');

    expect((await t.store.findOrder(order.orderId))?.version).toBe(3);
    expect(t.store.eventsOfType('OrderOnTheWay')).toHaveLength(1);
  });

  it('F4-S6 and F4-S8: a race lost to the API is rejected and recorded, not retried', async () => {
    const t = setup();
    const order = seeded(t.store);
    await t.submit.execute({
      orderId: order.orderId,
      type: 'PICKUP_CONFIRMED',
      caller: driver,
      correlationId: CORRELATION,
    });
    // The driver is released after the API accepted the intent.
    await t.unassigned.execute({
      eventId: randomUUID(),
      eventType: 'DriverUnassigned',
      orderId: order.orderId,
      driverId: DRIVER,
    });

    await expect(t.apply.execute(engineInput(t))).resolves.toBe('rejected');

    expect((await t.store.findOrder(order.orderId))?.status).toBe('CREATED');
    expect(t.store.rejected).toHaveLength(1);
    expect(t.store.rejected[0]).toMatchObject({
      orderId: order.orderId,
      intent: { type: 'PICKUP_CONFIRMED', actorId: DRIVER },
    });
    expect(t.store.eventsOfType('IntentRejected')[0].envelope).toMatchObject({
      aggregateVersion: 3,
      payload: {
        orderId: order.orderId,
        lastRejectedIntent: { type: 'PICKUP_CONFIRMED' },
      },
    });
  });

  it('records an intent for an order that does not exist', async () => {
    const t = setup();
    const orderId = randomUUID();
    const outcome = await t.apply.execute({
      intentId: randomUUID(),
      eventType: 'PickupConfirmed',
      orderId,
      intent: { type: 'PICKUP_CONFIRMED', actor: 'DRIVER', actorId: DRIVER },
      correlationId: CORRELATION,
    });

    expect(outcome).toBe('rejected');
    expect(t.store.rejected).toHaveLength(1);
    expect(t.store.outbox).toHaveLength(0);
  });
});

describe('Assignment events', () => {
  const event = (orderId: string, driverId = DRIVER) => ({
    eventId: randomUUID(),
    eventType: 'DriverAssigned',
    orderId,
    driverId,
  });

  it('step 3: records the driver, raises the version and publishes nothing', async () => {
    const t = setup();
    const order = seeded(t.store, 'CREATED', null);

    await expect(t.assigned.execute(event(order.orderId))).resolves.toBe(
      'applied',
    );

    expect(await t.store.findOrder(order.orderId)).toMatchObject({
      driverId: DRIVER,
      status: 'CREATED',
      version: 3,
    });
    expect(t.store.outbox).toHaveLength(0);
  });

  it('F4-S9: DriverAssigned for a CANCELLED order changes nothing', async () => {
    const t = setup();
    const order = seeded(t.store, 'CANCELLED', null);

    await expect(t.assigned.execute(event(order.orderId))).resolves.toBe(
      'ignored',
    );
    expect(await t.store.findOrder(order.orderId)).toMatchObject({
      driverId: null,
      status: 'CANCELLED',
      version: 2,
    });
  });

  it('F1-S6: DriverUnassigned clears the driver; a stale one is ignored', async () => {
    const t = setup();
    const order = seeded(t.store);

    await expect(
      t.unassigned.execute({
        ...event(order.orderId, OTHER_DRIVER),
        eventType: 'DriverUnassigned',
      }),
    ).resolves.toBe('ignored');
    await expect(
      t.unassigned.execute({
        ...event(order.orderId),
        eventType: 'DriverUnassigned',
      }),
    ).resolves.toBe('applied');

    expect((await t.store.findOrder(order.orderId))?.driverId).toBeNull();
  });

  it('is idempotent by eventId', async () => {
    const t = setup();
    const order = seeded(t.store, 'CREATED', null);
    const assigned = event(order.orderId);

    await t.assigned.execute(assigned);
    await expect(t.assigned.execute(assigned)).resolves.toBe('duplicate');
    expect((await t.store.findOrder(order.orderId))?.version).toBe(3);
  });

  it('an unknown order throws, and the event can be retried', async () => {
    const t = setup();
    const assigned = event(randomUUID());

    await expect(t.assigned.execute(assigned)).rejects.toBeInstanceOf(
      UnknownOrderError,
    );
    await expect(t.assigned.execute(assigned)).rejects.toBeInstanceOf(
      UnknownOrderError,
    );
  });
});

describe('PurgeExpired', () => {
  it('removes keys older than 24 h', async () => {
    const t = setup();
    await t.create.execute({
      customerId: CUSTOMER,
      destination: DESTINATION,
      idempotencyKey: KEY,
      correlationId: CORRELATION,
    });
    expect(t.store.keyCount).toBe(1);

    t.clock.advance(24 * 60 * 60 * 1000);
    await t.purge.execute();

    expect(t.store.keyCount).toBe(0);
  });
});
