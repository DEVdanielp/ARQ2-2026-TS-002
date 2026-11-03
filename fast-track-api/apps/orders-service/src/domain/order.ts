/**
 * The order aggregate and its state machine (spec 1 "Order lifecycle", F4).
 *
 * Plain functions over plain data, with no Nest, Kafka or SQL (ADR-014): the
 * rules that must never fail are tested with unit tests in domain.spec.ts.
 *
 *   CREATED ──PICKUP_CONFIRMED (driver)──▶ ON_THE_WAY ──DELIVERY_CONFIRMED (driver)──▶ DELIVERED
 *      │                                       │
 *      └─CANCELLATION_REQUESTED (customer)     └─CANCELLATION_REQUESTED (operations + reason)
 *                     ▼                                         ▼
 *                 CANCELLED ◀───────────────────────────────────┘
 *
 * Two functions look at the same rules from two places:
 * - `authorizeIntent` is the fast check of the REST API (403 / 409, spec 4.2).
 * - `decideIntent` is the authoritative check of the state engine: it runs one
 *   intent at a time per order against the current row (ADR-006).
 */

export const OrderStatuses = [
  'CREATED',
  'ON_THE_WAY',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof OrderStatuses)[number];

export const IntentTypes = [
  'PICKUP_CONFIRMED',
  'DELIVERY_CONFIRMED',
  'CANCELLATION_REQUESTED',
] as const;
export type IntentType = (typeof IntentTypes)[number];

export const Actors = ['CUSTOMER', 'DRIVER', 'OPERATIONS', 'SYSTEM'] as const;
export type Actor = (typeof Actors)[number];

/** Who can submit an intent; SYSTEM never does. */
export type IntentActor = Exclude<Actor, 'SYSTEM'>;

export const MAX_REASON_LENGTH = 300;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_NOTES_LENGTH = 500;

export interface Location {
  lat: number;
  lng: number;
}

export interface Destination {
  address: string;
  location: Location;
}

export interface Cancellation {
  actor: Actor;
  reason?: string;
}

export interface Order {
  orderId: string;
  customerId: string;
  driverId: string | null;
  destination: Destination;
  notes: string | null;
  status: OrderStatus;
  /** Starts at 1 and increases on every change (spec 3 `Order`). */
  version: number;
  cancellation: Cancellation | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The caller of the REST API, from the JWT. */
export interface Caller {
  userId: string;
  roles: readonly string[];
}

export interface Intent {
  type: IntentType;
  actor: IntentActor;
  actorId: string;
  reason?: string;
}

/** Event published after each transition (spec 5.4). */
export type TransitionEvent =
  | 'OrderOnTheWay'
  | 'OrderDelivered'
  | 'OrderCancelled';

export type IntentDecision =
  | { kind: 'apply'; status: OrderStatus; eventType: TransitionEvent }
  | { kind: 'reject'; reason: string };

export type IntentAuthorization =
  | { kind: 'allowed'; actor: IntentActor }
  | { kind: 'forbidden'; detail: string }
  | { kind: 'terminal' };

export function isTerminal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

export function newOrder(input: {
  orderId: string;
  customerId: string;
  destination: Destination;
  notes: string | null;
  now: Date;
}): Order {
  return {
    orderId: input.orderId,
    customerId: input.customerId,
    driverId: null,
    destination: input.destination,
    notes: input.notes,
    status: 'CREATED',
    version: 1,
    cancellation: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Which role the caller acts with for this intent; null if none of theirs may submit it. */
export function resolveActor(
  type: IntentType,
  roles: readonly string[],
): IntentActor | null {
  if (type !== 'CANCELLATION_REQUESTED') {
    return roles.includes('DRIVER') ? 'DRIVER' : null;
  }
  // With both roles, operations wins: it is the rule that also covers ON_THE_WAY.
  if (roles.includes('OPERATIONS')) return 'OPERATIONS';
  return roles.includes('CUSTOMER') ? 'CUSTOMER' : null;
}

/** Spec 4.2: only the owner, the assigned driver or operations see an order. */
export function canView(order: Order, caller: Caller): boolean {
  return (
    caller.roles.includes('OPERATIONS') ||
    (caller.roles.includes('CUSTOMER') &&
      order.customerId === caller.userId) ||
    (caller.roles.includes('DRIVER') && order.driverId === caller.userId)
  );
}

/**
 * The REST pre-check of an intent (spec 4.2, F4-S4, F4-S6, F4-S8). Role and
 * ownership come first, so a stranger never learns that an order is terminal.
 */
export function authorizeIntent(
  order: Order,
  caller: Caller,
  type: IntentType,
): IntentAuthorization {
  const actor = resolveActor(type, caller.roles);
  if (!actor) {
    return {
      kind: 'forbidden',
      detail:
        type === 'CANCELLATION_REQUESTED'
          ? 'Only the order owner or operations may cancel an order.'
          : 'Only the assigned driver may confirm pickup or delivery.',
    };
  }
  if (actor === 'DRIVER' && order.driverId !== caller.userId) {
    return {
      kind: 'forbidden',
      detail: `Order ${order.orderId} is not assigned to this driver.`,
    };
  }
  if (actor === 'CUSTOMER' && order.customerId !== caller.userId) {
    return {
      kind: 'forbidden',
      detail: `Order ${order.orderId} does not belong to this customer.`,
    };
  }
  if (isTerminal(order.status)) return { kind: 'terminal' };
  if (actor === 'CUSTOMER' && order.status !== 'CREATED') {
    return {
      kind: 'forbidden',
      detail: `Customers cannot cancel an order that is ${order.status}.`,
    };
  }
  return { kind: 'allowed', actor };
}

/**
 * The state engine's decision for one intent (F4). Rejections are expected
 * outcomes, not errors: they are recorded and never retried (spec 5.4).
 */
export function decideIntent(order: Order, intent: Intent): IntentDecision {
  if (isTerminal(order.status)) {
    return {
      kind: 'reject',
      reason: `Order is ${order.status}; ${intent.type} is not allowed.`,
    };
  }

  if (intent.type === 'CANCELLATION_REQUESTED') {
    return decideCancellation(order, intent);
  }

  if (intent.actor !== 'DRIVER' || order.driverId !== intent.actorId) {
    return {
      kind: 'reject',
      reason: 'Only the driver assigned to the order may confirm it.',
    };
  }
  if (intent.type === 'PICKUP_CONFIRMED') {
    return order.status === 'CREATED'
      ? { kind: 'apply', status: 'ON_THE_WAY', eventType: 'OrderOnTheWay' }
      : {
          kind: 'reject',
          reason: `Pickup cannot be confirmed while the order is ${order.status}.`,
        };
  }
  return order.status === 'ON_THE_WAY'
    ? { kind: 'apply', status: 'DELIVERED', eventType: 'OrderDelivered' }
    : {
        kind: 'reject',
        reason: `Delivery cannot be confirmed while the order is ${order.status}.`,
      };
}

function decideCancellation(order: Order, intent: Intent): IntentDecision {
  const cancelled: IntentDecision = {
    kind: 'apply',
    status: 'CANCELLED',
    eventType: 'OrderCancelled',
  };
  if (intent.actor === 'OPERATIONS') {
    return intent.reason?.trim()
      ? cancelled
      : { kind: 'reject', reason: 'Operations must give a reason to cancel.' };
  }
  if (intent.actor !== 'CUSTOMER' || order.customerId !== intent.actorId) {
    return {
      kind: 'reject',
      reason: 'Only the order owner or operations may cancel an order.',
    };
  }
  return order.status === 'CREATED'
    ? cancelled
    : {
        kind: 'reject',
        reason: `Customers cannot cancel an order that is ${order.status}.`,
      };
}

/** The order after a transition `decideIntent` accepted. */
export function applyTransition(
  order: Order,
  status: OrderStatus,
  intent: Intent,
  now: Date,
): Order {
  return {
    ...order,
    status,
    version: order.version + 1,
    updatedAt: now,
    cancellation:
      status === 'CANCELLED'
        ? {
            actor: intent.actor,
            ...(intent.reason ? { reason: intent.reason } : {}),
          }
        : order.cancellation,
  };
}

/**
 * Step 3 of the saga: records the driver. Only a `CREATED` order takes a
 * driver, so a late `DriverAssigned` never touches a terminal order (F4-S9).
 *
 * @returns the changed order, or null when there is nothing to change.
 */
export function assignDriver(
  order: Order,
  driverId: string,
  now: Date,
): Order | null {
  if (order.status !== 'CREATED' || order.driverId === driverId) return null;
  return { ...order, driverId, version: order.version + 1, updatedAt: now };
}

/**
 * Compensation of step 3: clears the driver, unless the order already moved on
 * or belongs to someone else (spec 5.4 `DriverUnassigned`).
 *
 * @returns the changed order, or null when there is nothing to change.
 */
export function unassignDriver(
  order: Order,
  driverId: string,
  now: Date,
): Order | null {
  if (order.status !== 'CREATED' || order.driverId !== driverId) return null;
  return {
    ...order,
    driverId: null,
    version: order.version + 1,
    updatedAt: now,
  };
}
