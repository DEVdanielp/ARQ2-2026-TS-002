import { decideIntent } from './intent-state-engine.js';
import type { StateEngineOrder } from './intent-state-engine.js';

const order: StateEngineOrder = {
  orderId: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222',
  driverId: '33333333-3333-4333-8333-333333333333',
  status: 'CREATED',
  version: 1,
};

describe('decideIntent', () => {
  it('moves CREATED to ON_THE_WAY for the currently assigned driver', () => {
    expect(
      decideIntent(
        order,
        {
          type: 'PICKUP_CONFIRMED',
          actor: 'DRIVER',
          actorId: order.driverId!,
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'apply',
      transition: {
        status: 'ON_THE_WAY',
        eventType: 'OrderOnTheWay',
      },
    });
  });

  it('rejects pickup from a driver who has been unassigned', () => {
    expect(
      decideIntent(
        { ...order, driverId: null },
        {
          type: 'PICKUP_CONFIRMED',
          actor: 'DRIVER',
          actorId: order.driverId!,
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'reject',
      reason: 'Only the currently assigned driver may confirm pickup.',
    });
  });

  it('moves ON_THE_WAY to DELIVERED for the assigned driver', () => {
    expect(
      decideIntent(
        { ...order, status: 'ON_THE_WAY', version: 2 },
        {
          type: 'DELIVERY_CONFIRMED',
          actor: 'DRIVER',
          actorId: order.driverId!,
        },
        '2026-10-18T15:45:00.000Z',
      ),
    ).toMatchObject({
      kind: 'apply',
      transition: {
        status: 'DELIVERED',
        eventType: 'OrderDelivered',
      },
    });
  });

  it('allows the customer to cancel an order before pickup', () => {
    expect(
      decideIntent(
        order,
        {
          type: 'CANCELLATION_REQUESTED',
          actor: 'CUSTOMER',
          actorId: order.customerId,
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'apply',
      transition: {
        status: 'CANCELLED',
        eventType: 'OrderCancelled',
      },
    });
  });

  it('rejects customer cancellation after pickup', () => {
    expect(
      decideIntent(
        { ...order, status: 'ON_THE_WAY', version: 2 },
        {
          type: 'CANCELLATION_REQUESTED',
          actor: 'CUSTOMER',
          actorId: order.customerId,
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'reject',
      reason: 'Customers may only cancel orders before pickup.',
    });
  });

  it('requires a reason for operations cancellation', () => {
    expect(
      decideIntent(
        { ...order, status: 'ON_THE_WAY', version: 2 },
        {
          type: 'CANCELLATION_REQUESTED',
          actor: 'OPERATIONS',
          actorId: '44444444-4444-4444-8444-444444444444',
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'reject',
      reason: 'An operations cancellation requires a reason.',
    });
  });

  it('allows operations to cancel an active order with a reason', () => {
    expect(
      decideIntent(
        { ...order, status: 'ON_THE_WAY', version: 2 },
        {
          type: 'CANCELLATION_REQUESTED',
          actor: 'OPERATIONS',
          actorId: '44444444-4444-4444-8444-444444444444',
          reason: 'Recipient unreachable',
        },
        '2026-10-18T15:20:00.000Z',
      ),
    ).toMatchObject({
      kind: 'apply',
      transition: {
        status: 'CANCELLED',
        eventType: 'OrderCancelled',
        payload: {
          cancellation: {
            actor: 'OPERATIONS',
            reason: 'Recipient unreachable',
          },
        },
      },
    });
  });

  it.each(['DELIVERED', 'CANCELLED'] as const)(
    'rejects intents when order is terminal (%s)',
    (status) => {
      expect(
        decideIntent(
          { ...order, status, version: 3 },
          {
            type: 'CANCELLATION_REQUESTED',
            actor: 'OPERATIONS',
            actorId: '44444444-4444-4444-8444-444444444444',
            reason: 'Cancellation',
          },
          '2026-10-18T15:20:00.000Z',
        ),
      ).toMatchObject({
        kind: 'reject',
        reason: `Order is already ${status}.`,
      });
    },
  );
});
