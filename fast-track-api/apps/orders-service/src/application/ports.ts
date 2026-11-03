/**
 * Ports: what the use cases need from the outside world (ADR-014).
 *
 * The application layer declares these abstract classes; the adapters
 * implement them (PostgreSQL through TypeORM + the outbox, Kafka). Use cases
 * depend only on these declarations, so they are tested with in-memory fakes
 * (application/testing/in-memory.ts).
 *
 * They are abstract classes (not interfaces) because Nest needs a runtime
 * token to inject an implementation.
 *
 * `OrderSession` is one database transaction in which a use case reads,
 * decides (domain rules) and writes, and in which events are written to the
 * outbox (ADR-005). Everything done through it commits together or not at all.
 */
import type { EventEnvelope } from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type { Intent, Order, OrderStatus } from '../domain/order.js';

/** A successful response kept for 24 h, returned again on a repeated key (spec 2). */
export interface StoredResponse {
  requestHash: string;
  status: number;
  body: unknown;
}

/** Identifies one use of an `Idempotency-Key`. */
export interface IdempotencyScope {
  ownerId: string;
  /** Which endpoint: the same key may be used on two different ones. */
  scope: string;
  key: string;
}

export interface RejectedIntent {
  intentId: string;
  orderId: string;
  intent: Intent;
  reason: string;
  rejectedAt: Date;
}

export interface OrderSession {
  /**
   * Records that this consumed event was handled (table `processed_events`).
   * @returns false if it was already handled: the caller must stop (ADR-009).
   */
  markProcessed(eventId: string, eventType: string): Promise<boolean>;

  findOrder(orderId: string): Promise<Order | null>;
  /** The order, locked until commit: the REST API and two consumers change orders. */
  lockOrder(orderId: string): Promise<Order | null>;
  insertOrder(order: Order): Promise<void>;
  updateOrder(order: Order): Promise<void>;

  /** An intent that was not applied (spec 5.4: "rejected and recorded"). */
  recordRejectedIntent(rejected: RejectedIntent): Promise<void>;

  /** Serializes requests with the same key until commit (two identical parallel POSTs). */
  lockIdempotencyKey(target: IdempotencyScope): Promise<void>;
  /** The stored response, unless it is older than 24 h. */
  findResponse(
    target: IdempotencyScope,
    now: Date,
  ): Promise<StoredResponse | null>;
  saveResponse(
    target: IdempotencyScope,
    response: StoredResponse,
    expiresAt: Date,
  ): Promise<void>;

  /** Writes an event to the outbox, in this transaction. */
  publish(message: OutboxMessage): Promise<void>;
}

export interface OrderFilter {
  /** With both, orders matching either one; with neither, every order. */
  customerId?: string;
  driverId?: string;
  status?: OrderStatus;
}

export interface OrderPage {
  items: Order[];
  total: number;
}

export abstract class OrdersStore {
  /** Runs `work` in one transaction. */
  abstract inSession<T>(work: (session: OrderSession) => Promise<T>): Promise<T>;

  // Read-only queries (no transaction needed).
  abstract findOrder(orderId: string): Promise<Order | null>;
  /** Newest first. `page` starts at 0. */
  abstract listOrders(
    filter: OrderFilter,
    page: number,
    size: number,
  ): Promise<OrderPage>;

  /** Deletes expired idempotency keys and processed ids older than `processedBefore`. */
  abstract purgeExpired(now: Date, processedBefore: Date): Promise<void>;
}

/**
 * Publishes an intent to `orders.intents` and waits for Kafka's confirmation.
 *
 * Not through the outbox: an intent is a request, not a fact. The client must
 * learn right now if it was not queued (spec 4.2: `503`, ADR-006).
 *
 * @throws {ServiceUnavailableError} if Kafka does not confirm the write.
 */
export abstract class IntentPublisher {
  abstract publish(orderId: string, envelope: EventEnvelope): Promise<void>;
}

/** Current time, injectable so tests can move it (the 24 h of the keys). */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
