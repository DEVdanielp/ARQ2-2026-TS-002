import type { OrderStatus, UserRole } from '../domain/order.js';

export type OrderIntentType =
  | 'PICKUP_CONFIRMED'
  | 'DELIVERY_CONFIRMED'
  | 'CANCELLATION_REQUESTED';

export interface StateEngineOrder {
  orderId: string;
  customerId: string;
  driverId: string | null;
  status: OrderStatus;
  version: number;
}

export interface OrderIntent {
  type: OrderIntentType;
  actor: UserRole;
  actorId: string;
  reason?: string;
}

export interface Transition {
  status: OrderStatus;
  eventType: 'OrderOnTheWay' | 'OrderDelivered' | 'OrderCancelled';
  payload: Record<string, unknown>;
}

export type IntentDecision =
  | { kind: 'apply'; transition: Transition }
  | { kind: 'reject'; reason: string };

export function decideIntent(
  order: StateEngineOrder,
  intent: OrderIntent,
  changedAt: string,
): IntentDecision {
  if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
    return { kind: 'reject', reason: `Order is already ${order.status}.` };
  }

  if (intent.type === 'PICKUP_CONFIRMED') {
    if (intent.actor !== 'DRIVER' || order.driverId !== intent.actorId) {
      return {
        kind: 'reject',
        reason: 'Only the currently assigned driver may confirm pickup.',
      };
    }
    if (order.status !== 'CREATED') {
      return {
        kind: 'reject',
        reason: `Pickup is not allowed while the order is ${order.status}.`,
      };
    }
    return {
      kind: 'apply',
      transition: {
        status: 'ON_THE_WAY',
        eventType: 'OrderOnTheWay',
        payload: {
          orderId: order.orderId,
          status: 'ON_THE_WAY',
          previousStatus: 'CREATED',
          driverId: order.driverId,
          changedAt,
        },
      },
    };
  }

  if (intent.type === 'DELIVERY_CONFIRMED') {
    if (intent.actor !== 'DRIVER' || order.driverId !== intent.actorId) {
      return {
        kind: 'reject',
        reason: 'Only the currently assigned driver may confirm delivery.',
      };
    }
    if (order.status !== 'ON_THE_WAY') {
      return {
        kind: 'reject',
        reason: `Delivery is not allowed while the order is ${order.status}.`,
      };
    }
    return {
      kind: 'apply',
      transition: {
        status: 'DELIVERED',
        eventType: 'OrderDelivered',
        payload: {
          orderId: order.orderId,
          status: 'DELIVERED',
          previousStatus: 'ON_THE_WAY',
          driverId: order.driverId,
          changedAt,
        },
      },
    };
  }

  if (intent.actor === 'CUSTOMER') {
    if (order.customerId !== intent.actorId) {
      return {
        kind: 'reject',
        reason: 'Only the order owner may cancel it.',
      };
    }
    if (order.status !== 'CREATED') {
      return {
        kind: 'reject',
        reason: 'Customers may only cancel orders before pickup.',
      };
    }
  } else if (intent.actor === 'OPERATIONS') {
    if (!intent.reason?.trim()) {
      return {
        kind: 'reject',
        reason: 'An operations cancellation requires a reason.',
      };
    }
  } else {
    return {
      kind: 'reject',
      reason: 'Drivers cannot submit a cancellation request.',
    };
  }
  if (intent.reason && intent.reason.length > 300) {
    return {
      kind: 'reject',
      reason: 'Cancellation reason cannot exceed 300 characters.',
    };
  }

  return {
    kind: 'apply',
    transition: {
      status: 'CANCELLED',
      eventType: 'OrderCancelled',
      payload: {
        orderId: order.orderId,
        status: 'CANCELLED',
        previousStatus: order.status,
        driverId: order.driverId,
        cancellation: {
          actor: intent.actor,
          ...(intent.reason === undefined ? {} : { reason: intent.reason }),
        },
        changedAt,
      },
    },
  };
}
