/**
 * PostgreSQL implementation of `OrdersStore` (application/ports.ts).
 *
 * Plain SQL through TypeORM's EntityManager, like Profiles and the GPS Tracking
 * Worker: the rules rely on row locks, advisory locks and `ON CONFLICT`, which
 * read more clearly as SQL than as entity mappings.
 *
 * Concurrency
 * -----------
 * Orders change from two consumers (intents, assignment events), so the state
 * engine locks the row (`FOR UPDATE`). Requests with the same `Idempotency-Key`
 * wait on an advisory lock, which works before the key's row exists and is
 * released automatically at commit or rollback.
 *
 * When the database cannot be reached, the store throws
 * `ServiceUnavailableError` (spec 4.2: `503`).
 */
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { OutboxService, type OutboxMessage } from '@libs/outbox';
import type { Actor, Order, OrderStatus } from '../../../domain/order.js';
import { ServiceUnavailableError } from '../../../application/errors.js';
import {
  OrdersStore,
  type IdempotencyScope,
  type OrderFilter,
  type OrderPage,
  type OrderSession,
  type RejectedIntent,
  type StoredResponse,
} from '../../../application/ports.js';

/** Advisory lock namespace (two-int form), distinct per purpose. */
const IDEMPOTENCY_LOCK = 'SELECT pg_advisory_xact_lock(1903, hashtext($1))';

const ORDER_COLUMNS = `order_id, customer_id, driver_id, destination_address, destination_lat, destination_lng,
       notes, status, version, cancellation_actor, cancellation_reason, created_at, updated_at`;

interface OrderRow {
  order_id: string;
  customer_id: string;
  driver_id: string | null;
  destination_address: string;
  destination_lat: number;
  destination_lng: number;
  notes: string | null;
  status: OrderStatus;
  version: number;
  cancellation_actor: Actor | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toOrder = (row: OrderRow): Order => ({
  orderId: row.order_id,
  customerId: row.customer_id,
  driverId: row.driver_id,
  destination: {
    address: row.destination_address,
    location: { lat: row.destination_lat, lng: row.destination_lng },
  },
  notes: row.notes,
  status: row.status,
  version: row.version,
  cancellation: row.cancellation_actor
    ? {
        actor: row.cancellation_actor,
        ...(row.cancellation_reason
          ? { reason: row.cancellation_reason }
          : {}),
      }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const lockKey = (target: IdempotencyScope): string =>
  `${target.ownerId}:${target.scope}:${target.key}`;

class PostgresOrderSession implements OrderSession {
  constructor(
    private readonly manager: EntityManager,
    private readonly outbox: OutboxService,
  ) {}

  async markProcessed(eventId: string, eventType: string): Promise<boolean> {
    const rows: unknown[] = await this.manager.query(
      `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, eventType],
    );
    return rows.length > 0;
  }

  async findOrder(orderId: string): Promise<Order | null> {
    const rows: OrderRow[] = await this.manager.query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = $1`,
      [orderId],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async lockOrder(orderId: string): Promise<Order | null> {
    const rows: OrderRow[] = await this.manager.query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async insertOrder(order: Order): Promise<void> {
    await this.manager.query(
      `INSERT INTO orders (order_id, customer_id, driver_id, destination_address, destination_lat, destination_lng,
                           notes, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        order.orderId,
        order.customerId,
        order.driverId,
        order.destination.address,
        order.destination.location.lat,
        order.destination.location.lng,
        order.notes,
        order.status,
        order.version,
        order.createdAt,
        order.updatedAt,
      ],
    );
  }

  async updateOrder(order: Order): Promise<void> {
    await this.manager.query(
      `UPDATE orders
          SET driver_id = $2, status = $3, version = $4, cancellation_actor = $5, cancellation_reason = $6, updated_at = $7
        WHERE order_id = $1`,
      [
        order.orderId,
        order.driverId,
        order.status,
        order.version,
        order.cancellation?.actor ?? null,
        order.cancellation?.reason ?? null,
        order.updatedAt,
      ],
    );
  }

  async recordRejectedIntent(rejected: RejectedIntent): Promise<void> {
    await this.manager.query(
      `INSERT INTO rejected_intents (intent_id, order_id, type, actor, actor_id, reason, rejected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        rejected.intentId,
        rejected.orderId,
        rejected.intent.type,
        rejected.intent.actor,
        rejected.intent.actorId,
        rejected.reason,
        rejected.rejectedAt,
      ],
    );
  }

  async lockIdempotencyKey(target: IdempotencyScope): Promise<void> {
    await this.manager.query(IDEMPOTENCY_LOCK, [lockKey(target)]);
  }

  async findResponse(
    target: IdempotencyScope,
    now: Date,
  ): Promise<StoredResponse | null> {
    const rows: Array<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }> = await this.manager.query(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE owner_id = $1 AND scope = $2 AND idempotency_key = $3 AND expires_at > $4`,
      [target.ownerId, target.scope, target.key, now],
    );
    const row = rows[0];
    return row
      ? {
          requestHash: row.request_hash,
          status: row.response_status,
          body: row.response_body,
        }
      : null;
  }

  async saveResponse(
    target: IdempotencyScope,
    response: StoredResponse,
    expiresAt: Date,
  ): Promise<void> {
    // The key may still be here, expired, if the cleanup has not reached it.
    await this.manager.query(
      `INSERT INTO idempotency_keys (owner_id, scope, idempotency_key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, scope, idempotency_key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, response_status = EXCLUDED.response_status,
             response_body = EXCLUDED.response_body, created_at = now(), expires_at = EXCLUDED.expires_at`,
      [
        target.ownerId,
        target.scope,
        target.key,
        response.requestHash,
        response.status,
        JSON.stringify(response.body),
        expiresAt,
      ],
    );
  }

  publish(message: OutboxMessage): Promise<void> {
    return this.outbox.enqueue(this.manager, message);
  }
}

/** Network failures and PostgreSQL's "connection" (08) and "shutting down" (57P0x) classes. */
function isConnectionFailure(error: unknown): boolean {
  const failure = error as {
    code?: string;
    driverError?: { code?: string };
    message?: string;
  };
  const code = failure.driverError?.code ?? failure.code ?? '';
  return (
    /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|08|57P0)/.test(code) ||
    /Connection terminated/i.test(failure.message ?? '')
  );
}

@Injectable()
export class PostgresOrdersStore extends OrdersStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  inSession<T>(work: (session: OrderSession) => Promise<T>): Promise<T> {
    return this.available(() =>
      this.dataSource.transaction((manager) =>
        work(new PostgresOrderSession(manager, this.outbox)),
      ),
    );
  }

  findOrder(orderId: string): Promise<Order | null> {
    return this.available(() =>
      new PostgresOrderSession(this.dataSource.manager, this.outbox).findOrder(
        orderId,
      ),
    );
  }

  listOrders(
    filter: OrderFilter,
    page: number,
    size: number,
  ): Promise<OrderPage> {
    const params: unknown[] = [];
    const param = (value: unknown): string => `$${params.push(value)}`;

    const owners: string[] = [];
    if (filter.customerId) {
      owners.push(`customer_id = ${param(filter.customerId)}`);
    }
    if (filter.driverId) owners.push(`driver_id = ${param(filter.driverId)}`);

    const conditions: string[] = [];
    if (owners.length > 0) conditions.push(`(${owners.join(' OR ')})`);
    if (filter.status) conditions.push(`status = ${param(filter.status)}`);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.available(async () => {
      const counted: Array<{ total: number }> = await this.dataSource.query(
        `SELECT count(*)::int AS total FROM orders ${where}`,
        params,
      );
      const rows: OrderRow[] = await this.dataSource.query(
        `SELECT ${ORDER_COLUMNS} FROM orders ${where}
          ORDER BY created_at DESC, order_id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, size, page * size],
      );
      return { items: rows.map(toOrder), total: counted[0].total };
    });
  }

  async purgeExpired(now: Date, processedBefore: Date): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM idempotency_keys WHERE expires_at <= $1`,
      [now],
    );
    await this.dataSource.query(
      `DELETE FROM processed_events WHERE processed_at < $1`,
      [processedBefore],
    );
  }

  private async available<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new ServiceUnavailableError('The database');
      }
      throw error;
    }
  }
}
