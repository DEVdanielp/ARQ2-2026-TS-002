/**
 * The state machine of F4: every rule that must never fail, without Kafka or
 * PostgreSQL (ADR-014).
 */
import {
  applyTransition,
  assignDriver,
  authorizeIntent,
  canView,
  decideIntent,
  newOrder,
  resolveActor,
  unassignDriver,
  type Intent,
  type Order,
  type OrderStatus,
} from './order.js';

const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const OTHER_DRIVER = '9a1b2c3d-0000-4000-8000-000000000002';
const OPS = '7b8c9d0e-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-18T15:00:00Z');

function order(status: OrderStatus, driverId: string | null = DRIVER): Order {
  return {
    ...newOrder({
      orderId: '6f1c2b7e-0000-4000-8000-000000000001',
      customerId: CUSTOMER,
      destination: {
        address: 'Cra 43A #1-50',
        location: { lat: 6.2088, lng: -75.5679 },
      },
      notes: null,
      now: NOW,
    }),
    status,
    driverId,
  };
}

const pickup: Intent = {
  type: 'PICKUP_CONFIRMED',
  actor: 'DRIVER',
  actorId: DRIVER,
};
const delivery: Intent = { ...pickup, type: 'DELIVERY_CONFIRMED' };
const customerCancel: Intent = {
  type: 'CANCELLATION_REQUESTED',
  actor: 'CUSTOMER',
  actorId: CUSTOMER,
};
const opsCancel: Intent = {
  type: 'CANCELLATION_REQUESTED',
  actor: 'OPERATIONS',
  actorId: OPS,
  reason: 'Recipient unreachable',
};

describe('decideIntent', () => {
  it('F4-S1: the assigned driver picks up a CREATED order', () => {
    expect(decideIntent(order('CREATED'), pickup)).toEqual({
      kind: 'apply',
      status: 'ON_THE_WAY',
      eventType: 'OrderOnTheWay',
    });
  });

  it('F4-S2: the driver delivers an ON_THE_WAY order', () => {
    expect(decideIntent(order('ON_THE_WAY'), delivery)).toEqual({
      kind: 'apply',
      status: 'DELIVERED',
      eventType: 'OrderDelivered',
    });
  });

  it('F4-S3: the customer cancels a CREATED order', () => {
    expect(decideIntent(order('CREATED'), customerCancel)).toMatchObject({
      kind: 'apply',
      status: 'CANCELLED',
      eventType: 'OrderCancelled',
    });
  });

  it('F4-S4: the customer cannot cancel an ON_THE_WAY order', () => {
    expect(decideIntent(order('ON_THE_WAY'), customerCancel).kind).toBe(
      'reject',
    );
  });

  it('F4-S5: operations cancels ON_THE_WAY with a reason, never without one', () => {
    expect(decideIntent(order('ON_THE_WAY'), opsCancel).kind).toBe('apply');
    expect(
      decideIntent(order('ON_THE_WAY'), { ...opsCancel, reason: '  ' }).kind,
    ).toBe('reject');
  });

  it.each(['DELIVERED', 'CANCELLED'] as const)(
    'F4-S6: nothing leaves the terminal status %s',
    (status) => {
      for (const intent of [pickup, delivery, customerCancel, opsCancel]) {
        expect(decideIntent(order(status), intent).kind).toBe('reject');
      }
    },
  );

  it('F4-S8: a driver who is no longer assigned is rejected', () => {
    expect(
      decideIntent(order('CREATED', OTHER_DRIVER), pickup).kind,
    ).toBe('reject');
    expect(decideIntent(order('CREATED', null), pickup).kind).toBe('reject');
  });

  it('skips no step: delivery needs a pickup, and pickup happens once', () => {
    expect(decideIntent(order('CREATED'), delivery).kind).toBe('reject');
    expect(decideIntent(order('ON_THE_WAY'), pickup).kind).toBe('reject');
  });

  it('rejects a cancellation from someone who is not the owner', () => {
    expect(
      decideIntent(order('CREATED'), { ...customerCancel, actorId: OPS }).kind,
    ).toBe('reject');
    expect(
      decideIntent(order('CREATED'), {
        ...customerCancel,
        actor: 'DRIVER',
        actorId: DRIVER,
      }).kind,
    ).toBe('reject');
  });
});

describe('applyTransition', () => {
  it('raises the version and keeps who cancelled and why', () => {
    const cancelled = applyTransition(
      order('ON_THE_WAY'),
      'CANCELLED',
      opsCancel,
      NOW,
    );
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      version: 2,
      cancellation: { actor: 'OPERATIONS', reason: 'Recipient unreachable' },
    });
  });

  it('leaves the cancellation empty on other transitions', () => {
    expect(
      applyTransition(order('CREATED'), 'ON_THE_WAY', pickup, NOW).cancellation,
    ).toBeNull();
  });
});

describe('authorizeIntent', () => {
  const customer = { userId: CUSTOMER, roles: ['CUSTOMER'] };
  const driver = { userId: DRIVER, roles: ['DRIVER'] };
  const ops = { userId: OPS, roles: ['OPERATIONS'] };

  it('allows the assigned driver, the owner and operations', () => {
    expect(
      authorizeIntent(order('CREATED'), driver, 'PICKUP_CONFIRMED'),
    ).toEqual({ kind: 'allowed', actor: 'DRIVER' });
    expect(
      authorizeIntent(order('CREATED'), customer, 'CANCELLATION_REQUESTED'),
    ).toEqual({ kind: 'allowed', actor: 'CUSTOMER' });
    expect(
      authorizeIntent(order('ON_THE_WAY'), ops, 'CANCELLATION_REQUESTED'),
    ).toEqual({ kind: 'allowed', actor: 'OPERATIONS' });
  });

  it('F4-S4: 403 for a customer cancelling ON_THE_WAY', () => {
    expect(
      authorizeIntent(order('ON_THE_WAY'), customer, 'CANCELLATION_REQUESTED')
        .kind,
    ).toBe('forbidden');
  });

  it('F4-S6: 409 for the owner of a terminal order', () => {
    expect(
      authorizeIntent(order('DELIVERED'), customer, 'CANCELLATION_REQUESTED')
        .kind,
    ).toBe('terminal');
  });

  it('F4-S8: 403 for an unassigned driver, even on a terminal order', () => {
    expect(
      authorizeIntent(
        order('CREATED', OTHER_DRIVER),
        driver,
        'PICKUP_CONFIRMED',
      ).kind,
    ).toBe('forbidden');
    expect(
      authorizeIntent(
        order('DELIVERED', OTHER_DRIVER),
        driver,
        'DELIVERY_CONFIRMED',
      ).kind,
    ).toBe('forbidden');
  });

  it('403 for a role that may not submit the intent', () => {
    expect(
      authorizeIntent(order('CREATED'), customer, 'PICKUP_CONFIRMED').kind,
    ).toBe('forbidden');
    expect(
      authorizeIntent(order('CREATED'), driver, 'CANCELLATION_REQUESTED').kind,
    ).toBe('forbidden');
  });
});

describe('resolveActor', () => {
  it('prefers operations for a cancellation', () => {
    expect(
      resolveActor('CANCELLATION_REQUESTED', ['CUSTOMER', 'OPERATIONS']),
    ).toBe('OPERATIONS');
  });

  it('returns null when no role fits', () => {
    expect(resolveActor('PICKUP_CONFIRMED', ['OPERATIONS'])).toBeNull();
  });
});

describe('canView', () => {
  it('lets in the owner, the assigned driver and operations only', () => {
    const visible = order('CREATED');
    expect(canView(visible, { userId: CUSTOMER, roles: ['CUSTOMER'] })).toBe(
      true,
    );
    expect(canView(visible, { userId: DRIVER, roles: ['DRIVER'] })).toBe(true);
    expect(canView(visible, { userId: OPS, roles: ['OPERATIONS'] })).toBe(true);
    expect(canView(visible, { userId: OPS, roles: ['CUSTOMER'] })).toBe(false);
    expect(canView(visible, { userId: OPS, roles: ['DRIVER'] })).toBe(false);
  });
});

describe('driver assignment (saga steps)', () => {
  it('records the driver and raises the version', () => {
    expect(assignDriver(order('CREATED', null), DRIVER, NOW)).toMatchObject({
      driverId: DRIVER,
      version: 2,
    });
  });

  it('F4-S9: ignores DriverAssigned for a terminal order', () => {
    expect(assignDriver(order('CANCELLED', null), DRIVER, NOW)).toBeNull();
  });

  it('changes nothing when the same driver arrives again', () => {
    expect(assignDriver(order('CREATED'), DRIVER, NOW)).toBeNull();
  });

  it('F1-S6: clears the driver of a CREATED order', () => {
    expect(unassignDriver(order('CREATED'), DRIVER, NOW)).toMatchObject({
      driverId: null,
      version: 2,
    });
  });

  it('ignores DriverUnassigned for another driver or after pickup', () => {
    expect(unassignDriver(order('CREATED'), OTHER_DRIVER, NOW)).toBeNull();
    expect(unassignDriver(order('ON_THE_WAY'), DRIVER, NOW)).toBeNull();
  });
});
