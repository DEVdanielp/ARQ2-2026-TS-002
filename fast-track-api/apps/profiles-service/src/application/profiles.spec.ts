/**
 * Use-case tests: the F1 scenarios of docs/spec.md section 6 (and the parts
 * of F4 that touch assignment), against the in-memory store and a fake clock.
 */
import { AssignmentWindow } from '../domain/assignment-window.js';
import type { Destination } from '../domain/profiles.js';
import {
  Assigner,
  RetryDueAssignments,
  StartAssignment,
  TrackOrderStatus,
  type OrderCreatedInput,
} from './assignment.use-cases.js';
import {
  GetCustomerProfile,
  SaveCustomerProfile,
} from './customer-profile.use-cases.js';
import {
  ChangeDriverAvailability,
  ChangeDriverCapacity,
  GetAssignment,
  SaveDriverProfile,
} from './driver-profile.use-cases.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  UnknownOrderError,
} from './errors.js';
import { AssignmentSettings } from './ports.js';
import { FakeClock, InMemoryProfilesStore } from './testing/in-memory.js';

const CUSTOMER = '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10';
const DESTINATION: Destination = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};
let eventSeq = 0;
const nextEventId = () =>
  `00000000-0000-4000-8000-${String(++eventSeq).padStart(12, '0')}`;

function setup() {
  const store = new InMemoryProfilesStore();
  const clock = new FakeClock(new Date('2026-10-18T15:01:00Z'));
  const settings = new AssignmentSettings(new AssignmentWindow(30, 600), 3);
  const assigner = new Assigner(settings);
  return {
    store,
    clock,
    start: new StartAssignment(store, assigner, clock),
    retry: new RetryDueAssignments(store, assigner, settings, clock),
    status: new TrackOrderStatus(store, assigner, clock),
    availability: new ChangeDriverAvailability(store, assigner, clock),
    capacity: new ChangeDriverCapacity(store),
    saveDriver: new SaveDriverProfile(store, settings, clock),
    saveCustomer: new SaveCustomerProfile(store, clock),
    getCustomer: new GetCustomerProfile(store),
    getAssignment: new GetAssignment(store),
  };
}

function orderCreated(
  orderId: string,
  overrides: Partial<OrderCreatedInput> = {},
): OrderCreatedInput {
  return {
    eventId: nextEventId(),
    correlationId: 'corr-order',
    orderId,
    customerId: CUSTOMER,
    destination: DESTINATION,
    version: 1,
    ...overrides,
  };
}

function statusEvent(
  orderId: string,
  status: 'ON_THE_WAY' | 'DELIVERED' | 'CANCELLED',
  version: number,
  driverId: string | null = null,
) {
  const eventType = {
    ON_THE_WAY: 'OrderOnTheWay',
    DELIVERED: 'OrderDelivered',
    CANCELLED: 'OrderCancelled',
  }[status];
  return {
    eventId: nextEventId(),
    eventType,
    orderId,
    status,
    version,
    driverId,
  };
}

// ---------------------------------------------------------------------- customers

describe('customer profile', () => {
  it('F1-S1: creating the profile stores it under the JWT sub and publishes CustomerContactUpdated', async () => {
    const t = setup();
    const result = await t.saveCustomer.execute(
      CUSTOMER,
      {
        name: 'Laura Gómez',
        email: 'laura@example.com',
        phone: '+573001234567',
      },
      'corr-1',
    );

    expect(result.created).toBe(true);
    expect(await t.getCustomer.execute(CUSTOMER)).toMatchObject({
      customerId: CUSTOMER,
      email: 'laura@example.com',
      contactVersion: 1,
    });
    expect(t.store.published).toHaveLength(1);
    expect(t.store.published[0]).toMatchObject({
      topic: 'profile.events',
      key: CUSTOMER,
      envelope: {
        eventType: 'CustomerContactUpdated',
        producer: 'profiles-service',
        correlationId: 'corr-1',
        aggregateId: CUSTOMER,
        aggregateVersion: 1,
        payload: {
          customerId: CUSTOMER,
          name: 'Laura Gómez',
          email: 'laura@example.com',
          phone: '+573001234567',
        },
      },
    });
  });

  it('an update publishes only when email or phone change, with a higher aggregateVersion', async () => {
    const t = setup();
    const base = { name: 'Laura', email: 'laura@example.com', phone: null };
    await t.saveCustomer.execute(CUSTOMER, base, 'c1');

    const renamed = await t.saveCustomer.execute(
      CUSTOMER,
      { ...base, name: 'Laura G.' },
      'c2',
    );
    expect(renamed.created).toBe(false);
    expect(t.store.published).toHaveLength(1);

    await t.saveCustomer.execute(
      CUSTOMER,
      { ...base, name: 'Laura G.', email: 'new@example.com' },
      'c3',
    );
    expect(t.store.published).toHaveLength(2);
    expect(t.store.published[1].envelope.aggregateVersion).toBe(2);
    expect((await t.getCustomer.execute(CUSTOMER)).createdAt).toEqual(
      new Date('2026-10-18T15:01:00Z'),
    );
  });

  it('GET of a profile never created is a NotFoundError (404)', async () => {
    await expect(setup().getCustomer.execute(CUSTOMER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------- drivers

describe('driver profile', () => {
  it('a new driver starts OFFLINE with the default capacity; an update keeps them', async () => {
    const t = setup();
    const created = await t.saveDriver.execute('d1', {
      name: 'Carlos Ruiz',
      phone: '+573109876543',
      vehiclePlate: 'ABC123',
    });
    expect(created).toMatchObject({
      created: true,
      driver: { availability: 'OFFLINE', capacity: 3, activeOrderIds: [] },
    });

    await t.availability.execute('d1', 'AVAILABLE', 'c');
    const updated = await t.saveDriver.execute('d1', {
      name: 'Carlos R.',
      phone: '+573109876543',
      vehiclePlate: 'XYZ987',
    });
    expect(updated).toMatchObject({
      created: false,
      driver: {
        name: 'Carlos R.',
        vehiclePlate: 'XYZ987',
        availability: 'AVAILABLE',
        capacity: 3,
      },
    });
  });

  it('availability and capacity of an unknown driver are NotFoundError (404)', async () => {
    const t = setup();
    await expect(
      t.availability.execute('nobody', 'AVAILABLE', 'c'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.capacity.execute('nobody', 4)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('capacity: out of range is 400, below the active orders is 409', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    await t.start.execute(orderCreated('o2'));

    await expect(t.capacity.execute('d1', 11)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(t.capacity.execute('d1', 1)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await t.capacity.execute('d1', 4)).toMatchObject({
      capacity: 4,
      activeOrderIds: ['o1', 'o2'],
      availability: 'EN_ROUTE',
    });
  });
});

// ---------------------------------------------------------------------- assignment saga

describe('assignment', () => {
  it('F1-S2: OrderCreated with an available driver assigns at once and publishes DriverAssigned', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1', name: 'Carlos Ruiz' });

    expect(await t.start.execute(orderCreated('o1'))).toBe('ASSIGNED');

    expect(t.store.request('o1')).toMatchObject({
      state: 'ASSIGNED',
      driverId: 'd1',
      orderStatus: 'CREATED',
      attempts: 1,
    });
    expect(t.store.driver('d1')).toMatchObject({
      availability: 'EN_ROUTE',
      activeOrderIds: ['o1'],
    });
    expect(t.store.published[0]).toMatchObject({
      topic: 'assignment.events',
      key: 'o1',
      envelope: {
        eventType: 'DriverAssigned',
        correlationId: 'corr-order',
        aggregateId: 'o1',
        payload: {
          orderId: 'o1',
          driverId: 'd1',
          driverName: 'Carlos Ruiz',
          destination: { location: { lat: 6.2088, lng: -75.5679 } },
          assignedAt: '2026-10-18T15:01:00.000Z',
        },
      },
    });
  });

  it('an EN_ROUTE driver with a free slot gets more orders; the least loaded driver goes first', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1', capacity: 2 });
    t.store.addDriver({
      driverId: 'd2',
      capacity: 2,
      lastAssignedAt: new Date('2026-10-18T14:00:00Z'),
    });

    await t.start.execute(orderCreated('o1')); // tie on load (0); d1 was never assigned -> d1
    await t.start.execute(orderCreated('o2')); // d2 has fewer active orders -> d2
    await t.start.execute(orderCreated('o3')); // tie on load (1) and on last assignment -> lowest id, d1

    expect(t.store.driver('d1')!.activeOrderIds).toEqual(['o1', 'o3']);
    expect(t.store.driver('d2')!.activeOrderIds).toEqual(['o2']);
  });

  it('F1-S4: a driver at full capacity receives nothing more', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1', capacity: 1 });

    await t.start.execute(orderCreated('o1'));
    expect(await t.start.execute(orderCreated('o2'))).toBe('NO_DRIVER');
    expect(t.store.driver('d1')!.activeOrderIds).toEqual(['o1']);
  });

  it('F1-S3: without drivers the order stays PENDING and is retried every 30 s', async () => {
    const t = setup();
    expect(await t.start.execute(orderCreated('o1'))).toBe('NO_DRIVER');
    expect(t.store.request('o1')).toMatchObject({
      state: 'PENDING',
      orderStatus: 'CREATED',
      attempts: 1,
      nextAttemptAt: new Date('2026-10-18T15:01:30Z'),
    });

    t.clock.advanceSeconds(29);
    expect((await t.retry.execute()).NO_DRIVER).toBe(0); // not due yet

    t.clock.advanceSeconds(1);
    t.store.addDriver({ driverId: 'd1' });
    expect((await t.retry.execute()).ASSIGNED).toBe(1);
    expect(t.store.publishedTypes()).toEqual(['DriverAssigned']);
  });

  it('F1-S3b: after 10 minutes without a driver, AssignmentFailed is published once; the order stays CREATED', async () => {
    const t = setup();
    await t.start.execute(orderCreated('o1'));
    for (let i = 0; i < 20; i++) {
      t.clock.advanceSeconds(30);
      await t.retry.execute();
    }

    expect(t.store.publishedTypes()).toEqual(['AssignmentFailed']);
    expect(t.store.published[0].envelope.payload).toEqual({
      orderId: 'o1',
      attempts: 20,
      windowStartedAt: '2026-10-18T15:01:00.000Z',
      failedAt: '2026-10-18T15:11:00.000Z',
    });
    expect(t.store.request('o1')).toMatchObject({
      state: 'FAILED',
      orderStatus: 'CREATED',
      nextAttemptAt: null,
    });

    t.clock.advanceSeconds(60);
    t.store.addDriver({ driverId: 'd1' });
    await t.retry.execute();
    expect(t.store.publishedTypes()).toEqual(['AssignmentFailed']); // no more attempts
  });

  it('a redelivered OrderCreated changes nothing (idempotent by eventId)', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    const event = orderCreated('o1');

    await t.start.execute(event);
    expect(await t.start.execute(event)).toBe('DUPLICATE');
    expect(t.store.publishedTypes()).toEqual(['DriverAssigned']);
    expect(t.store.driver('d1')!.activeOrderIds).toEqual(['o1']);
  });

  it('F1-S5: OrderDelivered releases the slot and the driver returns to AVAILABLE', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    await t.status.execute(statusEvent('o1', 'ON_THE_WAY', 3, 'd1'));

    expect(
      await t.status.execute(statusEvent('o1', 'DELIVERED', 4, 'd1')),
    ).toBe('APPLIED');
    expect(t.store.driver('d1')).toMatchObject({
      availability: 'AVAILABLE',
      activeOrderIds: [],
    });
    expect(await t.getAssignment.execute('o1')).toMatchObject({
      driverId: 'd1',
      releaseReason: 'DELIVERED',
      releasedAt: expect.any(Date),
    });
  });

  it('F1-S5 / saga compensation: OrderCancelled releases the slot and stops the retries', async () => {
    const t = setup();
    await t.start.execute(orderCreated('o1')); // no driver -> PENDING
    await t.status.execute(statusEvent('o1', 'CANCELLED', 2));

    t.clock.advanceSeconds(30);
    t.store.addDriver({ driverId: 'd1' });
    await t.retry.execute();
    expect(t.store.publishedTypes()).toEqual([]);
    expect(t.store.request('o1')).toMatchObject({
      orderStatus: 'CANCELLED',
      nextAttemptAt: null,
    });
  });

  it('status by aggregateVersion: a late or repeated event never moves the order backward', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    await t.status.execute(statusEvent('o1', 'DELIVERED', 4, 'd1'));

    expect(
      await t.status.execute(statusEvent('o1', 'ON_THE_WAY', 3, 'd1')),
    ).toBe('STALE');
    expect(t.store.request('o1')!.orderStatus).toBe('DELIVERED');

    const repeated = statusEvent('o1', 'CANCELLED', 5);
    await t.status.execute(repeated);
    expect(await t.status.execute(repeated)).toBe('DUPLICATE');
  });

  it('an order event for an unknown order throws (retried, then orders.events.dlq)', async () => {
    await expect(
      setup().status.execute(statusEvent('ghost', 'ON_THE_WAY', 2)),
    ).rejects.toBeInstanceOf(UnknownOrderError);
  });

  it('OrderOnTheWay naming another driver: Orders wins and our assignment follows it', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    t.store.addDriver({
      driverId: 'd2',
      lastAssignedAt: new Date('2026-10-18T15:00:00Z'),
    });
    await t.start.execute(orderCreated('o1')); // -> d1

    await t.status.execute(statusEvent('o1', 'ON_THE_WAY', 3, 'd2'));
    expect(t.store.driver('d1')).toMatchObject({
      activeOrderIds: [],
      availability: 'AVAILABLE',
    });
    expect(t.store.driver('d2')).toMatchObject({
      activeOrderIds: ['o1'],
      availability: 'EN_ROUTE',
    });
    expect(t.store.request('o1')).toMatchObject({
      state: 'ASSIGNED',
      driverId: 'd2',
    });
    // DriverAssigned(d2) again, so the GPS route and the tracking view follow Orders too.
    expect(t.store.publishedTypes()).toEqual([
      'DriverAssigned',
      'DriverAssigned',
    ]);
    expect(t.store.published[1].envelope.payload).toMatchObject({
      orderId: 'o1',
      driverId: 'd2',
      destination: { location: DESTINATION.location },
    });
  });
});

// ---------------------------------------------------------------------- driver going OFFLINE

describe('driver availability (F1-S6)', () => {
  it('OFFLINE with orders still CREATED: DriverUnassigned, then reassignment to another driver', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1')); // -> d1
    t.store.addDriver({ driverId: 'd2' });

    t.clock.advanceSeconds(300);
    const driver = await t.availability.execute(
      'd1',
      'OFFLINE',
      'corr-offline',
    );

    expect(driver).toMatchObject({
      availability: 'OFFLINE',
      activeOrderIds: [],
    });
    expect(t.store.publishedTypes()).toEqual([
      'DriverAssigned',
      'DriverUnassigned',
      'DriverAssigned',
    ]);
    expect(t.store.published[1]).toMatchObject({
      key: 'o1',
      envelope: {
        correlationId: 'corr-offline',
        payload: {
          orderId: 'o1',
          driverId: 'd1',
          reason: 'DRIVER_OFFLINE',
          unassignedAt: '2026-10-18T15:06:00.000Z',
        },
      },
    });
    expect(t.store.published[2].envelope.payload).toMatchObject({
      orderId: 'o1',
      driverId: 'd2',
    });
    // Consumers drop an assignment event that is not strictly newer than the
    // previous one of the order (Tracking Query: at <= assignmentAt -> ignore).
    const unassignedAt = (
      t.store.published[1].envelope.payload as { unassignedAt: string }
    ).unassignedAt;
    const assignedAt = (
      t.store.published[2].envelope.payload as { assignedAt: string }
    ).assignedAt;
    expect(new Date(assignedAt).getTime()).toBeGreaterThan(
      new Date(unassignedAt).getTime(),
    );
    expect(t.store.request('o1')).toMatchObject({
      state: 'ASSIGNED',
      driverId: 'd2',
      attempts: 1,
      windowStartedAt: new Date('2026-10-18T15:06:00Z'),
    });
  });

  it('OFFLINE with no other driver: the order waits with a NEW 10-minute window', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    t.clock.advanceSeconds(540); // 9 minutes into the first window

    await t.availability.execute('d1', 'OFFLINE', 'c');
    t.clock.advanceSeconds(120);
    await t.retry.execute();

    expect(t.store.publishedTypes()).toEqual([
      'DriverAssigned',
      'DriverUnassigned',
    ]); // not failed: the window restarted
    expect(t.store.request('o1')).toMatchObject({
      state: 'PENDING',
      driverId: null,
    });
  });

  it('OFFLINE with an order ON_THE_WAY is a ConflictError (409) and nothing changes', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    await t.start.execute(orderCreated('o2'));
    await t.status.execute(statusEvent('o1', 'ON_THE_WAY', 3, 'd1'));

    await expect(
      t.availability.execute('d1', 'OFFLINE', 'c'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(t.store.driver('d1')).toMatchObject({
      availability: 'EN_ROUTE',
      activeOrderIds: ['o1', 'o2'],
    });
    expect(t.store.publishedTypes()).toEqual([
      'DriverAssigned',
      'DriverAssigned',
    ]);
  });

  it('AVAILABLE is shown as EN_ROUTE while the driver has active orders', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1', availability: 'OFFLINE' });
    expect(await t.availability.execute('d1', 'AVAILABLE', 'c')).toMatchObject({
      availability: 'AVAILABLE',
    });

    await t.start.execute(orderCreated('o1'));
    expect(await t.availability.execute('d1', 'AVAILABLE', 'c')).toMatchObject({
      availability: 'EN_ROUTE',
    });
  });

  it('F4-S9: an order cancelled after its assignment releases the driver', async () => {
    const t = setup();
    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    await t.status.execute(statusEvent('o1', 'CANCELLED', 2));

    expect(t.store.driver('d1')).toMatchObject({
      availability: 'AVAILABLE',
      activeOrderIds: [],
    });
  });
});

describe('GET /assignments use case', () => {
  it('returns the latest assignment, or NotFoundError before any', async () => {
    const t = setup();
    await expect(t.getAssignment.execute('o1')).rejects.toBeInstanceOf(
      NotFoundError,
    );

    t.store.addDriver({ driverId: 'd1' });
    await t.start.execute(orderCreated('o1'));
    expect(await t.getAssignment.execute('o1')).toEqual({
      orderId: 'o1',
      driverId: 'd1',
      assignedAt: new Date('2026-10-18T15:01:00Z'),
      releasedAt: null,
      releaseReason: null,
    });
  });
});

describe('retry scheduler isolation', () => {
  it('an order whose attempt throws does not block the other due orders', async () => {
    const t = setup();
    await t.start.execute(orderCreated('o1'));
    await t.start.execute(orderCreated('o2'));
    t.store.addDriver({ driverId: 'd1' });
    t.clock.advanceSeconds(30);

    // Break o1 only: its driver lookup throws inside its own transaction.
    const original = t.store.inAssignmentSession.bind(t.store);
    let calls = 0;
    t.store.inAssignmentSession = (work) =>
      original(async (session) => {
        calls += 1;
        if (calls === 2) {
          return work({
            ...session,
            findAssignableDrivers: () => Promise.reject(new Error('boom')),
          });
        }
        return work(session);
      });

    const counts = await t.retry.execute();
    expect(counts.ASSIGNED).toBe(1);
    expect(t.store.request('o1')).toMatchObject({
      state: 'PENDING',
      attempts: 1,
    }); // rolled back, retried later
    expect(t.store.request('o2')).toMatchObject({
      state: 'ASSIGNED',
      driverId: 'd1',
    });
  });
});
