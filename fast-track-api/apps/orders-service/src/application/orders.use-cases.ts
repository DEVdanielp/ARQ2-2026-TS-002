/**
 * Use cases of the REST API (spec 4.2). The state engine is in
 * state-engine.use-cases.ts.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  authorizeIntent,
  canView,
  newOrder,
  resolveActor,
  type Caller,
  type Destination,
  type IntentType,
  type OrderStatus,
} from '../domain/order.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
} from './errors.js';
import { intentEnvelope, orderCreated, type IntentPayload } from './events.js';
import { intentIdFor, runIdempotent } from './idempotency.js';
import { orderView, type OrderView } from './order-view.js';
import {
  Clock,
  IntentPublisher,
  OrdersStore,
  type OrderFilter,
} from './ports.js';

export interface CreateOrderCommand {
  customerId: string;
  destination: Destination;
  notes?: string;
  idempotencyKey?: string;
  correlationId: string;
}

/** POST /orders: the order and `OrderCreated` commit together (ADR-005). */
@Injectable()
export class CreateOrder {
  constructor(
    private readonly store: OrdersStore,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateOrderCommand): Promise<OrderView> {
    const now = this.clock.now();
    const result = await this.store.inSession((session) =>
      runIdempotent<OrderView>(
        session,
        {
          ownerId: command.customerId,
          scope: 'POST /orders',
          key: command.idempotencyKey,
          fingerprint: {
            destination: command.destination,
            notes: command.notes ?? null,
          },
        },
        now,
        async () => {
          const order = newOrder({
            orderId: randomUUID(),
            customerId: command.customerId,
            destination: command.destination,
            notes: command.notes ?? null,
            now,
          });
          await session.insertOrder(order);
          await session.publish(orderCreated(order, command.correlationId));
          return { status: 201, body: orderView(order) };
        },
      ),
    );
    return result.body;
  }
}

/** GET /orders/{orderId}. */
@Injectable()
export class GetOrder {
  constructor(private readonly store: OrdersStore) {}

  async execute(orderId: string, caller: Caller): Promise<OrderView> {
    const order = await this.store.findOrder(orderId);
    if (!order) throw new NotFoundError(`Order ${orderId} not found`);
    if (!canView(order, caller)) {
      throw new ForbiddenError(`Order ${orderId} is not visible to this user.`);
    }
    return orderView(order);
  }
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  page: number;
  size: number;
}

/** GET /orders: customers see their own, drivers their assigned, operations all. */
@Injectable()
export class ListOrders {
  constructor(private readonly store: OrdersStore) {}

  async execute(
    caller: Caller,
    query: ListOrdersQuery,
  ): Promise<{
    items: OrderView[];
    page: number;
    size: number;
    total: number;
  }> {
    const { items, total } = await this.store.listOrders(
      this.filterFor(caller, query.status),
      query.page,
      query.size,
    );
    return {
      items: items.map(orderView),
      page: query.page,
      size: query.size,
      total,
    };
  }

  private filterFor(caller: Caller, status?: OrderStatus): OrderFilter {
    if (caller.roles.includes('OPERATIONS')) return { status };
    return {
      status,
      ...(caller.roles.includes('CUSTOMER')
        ? { customerId: caller.userId }
        : {}),
      ...(caller.roles.includes('DRIVER') ? { driverId: caller.userId } : {}),
    };
  }
}

export interface SubmitIntentCommand {
  orderId: string;
  type: IntentType;
  reason?: string;
  caller: Caller;
  idempotencyKey?: string;
  correlationId: string;
}

export interface IntentAccepted {
  intentId: string;
  orderId: string;
  type: IntentType;
  status: 'QUEUED';
}

/**
 * POST /orders/{orderId}/intents (ADR-006): checks what can be known now,
 * queues the intent and answers 202. The state engine decides; these checks
 * only spare the client a round trip (spec 4.2).
 */
@Injectable()
export class SubmitIntent {
  constructor(
    private readonly store: OrdersStore,
    private readonly publisher: IntentPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(command: SubmitIntentCommand): Promise<IntentAccepted> {
    const { orderId, type, caller, correlationId } = command;
    const reason = command.reason?.trim() || undefined;
    if (
      type === 'CANCELLATION_REQUESTED' &&
      resolveActor(type, caller.roles) === 'OPERATIONS' &&
      !reason
    ) {
      throw new InvalidInputError('reason', 'required for OPERATIONS');
    }

    const now = this.clock.now();
    const scope = `POST /orders/${orderId}/intents`;
    const result = await this.store.inSession((session) =>
      runIdempotent<IntentAccepted>(
        session,
        {
          ownerId: caller.userId,
          scope,
          key: command.idempotencyKey,
          fingerprint: { type, reason: reason ?? null },
        },
        now,
        async () => {
          const order = await session.findOrder(orderId);
          if (!order) throw new NotFoundError(`Order ${orderId} not found`);

          const decision = authorizeIntent(order, caller, type);
          if (decision.kind === 'forbidden') {
            throw new ForbiddenError(decision.detail);
          }
          if (decision.kind === 'terminal') {
            throw new ConflictError(
              'order-terminal',
              'Order is in a terminal state',
              `Order ${orderId} is ${order.status}.`,
            );
          }

          const intentId = intentIdFor(
            caller.userId,
            scope,
            command.idempotencyKey,
          );
          const payload: IntentPayload = {
            intentId,
            orderId,
            type,
            actor: decision.actor,
            actorId: caller.userId,
            ...(reason ? { reason } : {}),
            requestedAt: now.toISOString(),
          };
          await this.publisher.publish(
            orderId,
            intentEnvelope(payload, correlationId),
          );
          return {
            status: 202,
            body: { intentId, orderId, type, status: 'QUEUED' as const },
          };
        },
      ),
    );
    return result.body;
  }
}
