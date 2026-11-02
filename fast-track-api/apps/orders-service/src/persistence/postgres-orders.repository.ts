import { Injectable, Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ProblemError } from '../application/problem-error.js';
import { requestHash } from '../application/orders-application.service.js';
import type {
  CreateOrderInput,
  ListOrdersInput,
  OrdersRepository,
} from '../application/orders-repository.port.js';
import type {
  AuthenticatedUser,
  IntentInput,
  Order,
  StoredResponse,
  UserRole,
} from '../domain/order.js';

interface OrderRow {
  order_id: string;
  customer_id: string;
  driver_id: string | null;
  destination: Order['destination'];
  notes: string | null;
  status: Order['status'];
  version: number;
  cancellation_actor: UserRole | 'SYSTEM' | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface IdempotencyRow {
  request_hash: Buffer;
  response_status: number;
  response_body: Record<string, unknown>;
  response_headers: Record<string, string>;
}

@Injectable()
export class PostgresOrdersRepository implements OrdersRepository {
  private readonly logger = new Logger(PostgresOrdersRepository.name);
  private pool?: Pool;

  async createOrder(
    input: CreateOrderInput,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Order>> {
    return this.withIdempotency(
      input.customerId,
      'POST:/v1/orders',
      idempotencyKey,
      input,
      async (client) => {
        const orderId = randomUUID();
        const now = new Date();
        const inserted = await client.query<OrderRow>(
          `INSERT INTO orders (order_id, customer_id, destination, notes)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING *`,
          [orderId, input.customerId, JSON.stringify(input.destination), input.notes ?? null],
        );
        const order = mapOrder(inserted.rows[0]);

        await client.query(
          `INSERT INTO outbox (
             event_id, topic, aggregate_id, event_type, schema_version,
             occurred_at, correlation_id, aggregate_version, payload
           ) VALUES ($1, 'orders.events', $2, 'OrderCreated', 1, $3, $4, 1, $5::jsonb)`,
          [
            randomUUID(),
            orderId,
            now,
            correlationId,
            JSON.stringify({
              orderId,
              customerId: input.customerId,
              status: 'CREATED',
              destination: input.destination,
            }),
          ],
        );
        return {
          status: 201,
          body: order,
          headers: { Location: `/v1/orders/${orderId}` },
        };
      },
    );
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const result = await this.query<OrderRow>(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async findIdempotentResponse(
    ownerId: string,
    scope: string,
    key: string | undefined,
    input: unknown,
  ): Promise<StoredResponse<Record<string, unknown>> | null> {
    if (!key) {
      return null;
    }
    const result = await this.query<IdempotencyRow>(
      `SELECT request_hash, response_status, response_body, response_headers
       FROM idempotency_keys
       WHERE owner_id = $1 AND scope = $2 AND idempotency_key = $3
         AND expires_at > now()`,
      [ownerId, scope, key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (row.request_hash.toString('hex') !== requestHash(input)) {
      throw new ProblemError(
        409,
        'idempotency-conflict',
        'Idempotency key conflict',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return {
      status: row.response_status,
      body: row.response_body,
      headers: row.response_headers,
    };
  }

  async listOrders(
    user: AuthenticatedUser,
    query: ListOrdersInput,
  ): Promise<{ items: Order[]; page: number; size: number; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const addValue = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };

    if (user.roles.includes('OPERATIONS')) {
      // Operations may list all orders.
    } else if (user.roles.includes('CUSTOMER')) {
      conditions.push(`customer_id = ${addValue(user.id)}`);
    } else {
      conditions.push(`driver_id = ${addValue(user.id)}`);
    }
    if (query.status) {
      conditions.push(`status = ${addValue(query.status)}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await this.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM orders ${where}`,
      values,
    );
    const pageValues = [...values];
    pageValues.push(query.size, query.page * query.size);
    const result = await this.query<OrderRow>(
      `SELECT * FROM orders ${where}
       ORDER BY created_at DESC, order_id
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    return {
      items: result.rows.map(mapOrder),
      page: query.page,
      size: query.size,
      total: Number(countResult.rows[0].total),
    };
  }

  async queueIntent(
    order: Order,
    user: AuthenticatedUser,
    intent: IntentInput,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Record<string, unknown>>> {
    const actor =
      intent.type === 'PICKUP_CONFIRMED' || intent.type === 'DELIVERY_CONFIRMED'
        ? 'DRIVER'
        : user.roles.includes('OPERATIONS')
          ? 'OPERATIONS'
          : 'CUSTOMER';
    const input = {
      orderId: order.orderId,
      type: intent.type,
      actor,
      actorId: user.id,
      reason: intent.reason,
    };
    const scope = `POST:/v1/orders/${order.orderId}/intents`;
    return this.withIdempotency(
      user.id,
      scope,
      idempotencyKey,
      input,
      async (client) => {
        const intentId = randomUUID();
        const requestedAt = new Date();
        const eventType = {
          PICKUP_CONFIRMED: 'PickupConfirmed',
          DELIVERY_CONFIRMED: 'DeliveryConfirmed',
          CANCELLATION_REQUESTED: 'CancellationRequested',
        }[intent.type];
        const payload = {
          intentId,
          orderId: order.orderId,
          type: intent.type,
          actor: input.actor,
          actorId: user.id,
          ...(intent.reason === undefined ? {} : { reason: intent.reason }),
          requestedAt: requestedAt.toISOString(),
        };
        await client.query(
          `INSERT INTO outbox (
             event_id, topic, aggregate_id, event_type, schema_version,
             occurred_at, correlation_id, payload
           ) VALUES ($1, 'orders.intents', $2, $3, 1, $4, $5, $6::jsonb)`,
          [
            intentId,
            order.orderId,
            eventType,
            requestedAt,
            correlationId,
            JSON.stringify(payload),
          ],
        );
        return {
          status: 202,
          body: {
            intentId,
            orderId: order.orderId,
            type: intent.type,
            status: 'QUEUED',
          },
        };
      },
    );
  }

  private async withIdempotency<T>(
    ownerId: string,
    scope: string,
    key: string | undefined,
    input: unknown,
    operation: (client: PoolClient) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return this.transaction(async (client) => {
      if (key) {
        const lockName = `${ownerId}:${scope}:${key}`;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [lockName],
        );
        await client.query(
          `DELETE FROM idempotency_keys
           WHERE owner_id = $1 AND scope = $2 AND idempotency_key = $3
             AND expires_at <= now()`,
          [ownerId, scope, key],
        );
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body, response_headers
           FROM idempotency_keys
           WHERE owner_id = $1 AND scope = $2 AND idempotency_key = $3`,
          [ownerId, scope, key],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.request_hash.toString('hex') !== requestHash(input)) {
            throw new ProblemError(
              409,
              'idempotency-conflict',
              'Idempotency key conflict',
              'This Idempotency-Key was already used with a different request.',
            );
          }
          return {
            status: row.response_status,
            body: row.response_body as T,
            headers: row.response_headers,
          };
        }
      }

      const response = await operation(client);
      if (key) {
        await client.query(
          `INSERT INTO idempotency_keys (
             owner_id, scope, idempotency_key, request_hash,
             response_status, response_body, response_headers, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now() + interval '24 hours')`,
          [
            ownerId,
            scope,
            key,
            Buffer.from(requestHash(input), 'hex'),
            response.status,
            JSON.stringify(response.body),
            JSON.stringify(response.headers ?? {}),
          ],
        );
      }
      return response;
    });
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect().catch((error: unknown) => {
      throw unavailableDatabase(error);
    });
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        this.logger.error('Failed to roll back a PostgreSQL transaction', rollbackError);
      });
      if (isConnectionError(error)) {
        throw unavailableDatabase(error);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async query<T extends import('pg').QueryResultRow>(
    sql: string,
    values: unknown[],
  ) {
    try {
      return await this.getPool().query<T>(sql, values);
    } catch (error) {
      if (isConnectionError(error)) {
        throw unavailableDatabase(error);
      }
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private getPool(): Pool {
    if (!this.pool) {
      const connectionString = process.env.ORDERS_DATABASE_URL;
      if (!connectionString) {
        throw new ProblemError(
          503,
          'database-unavailable',
          'Database unavailable',
          'Orders database is not configured.',
        );
      }
      this.pool = new Pool({ connectionString });
    }
    return this.pool;
  }
}

function mapOrder(row: OrderRow): Order {
  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    driverId: row.driver_id,
    destination: row.destination,
    ...(row.notes === null ? {} : { notes: row.notes }),
    status: row.status,
    version: row.version,
    cancellation:
      row.cancellation_actor === null
        ? null
        : {
            actor: row.cancellation_actor,
            ...(row.cancellation_reason === null
              ? {}
              : { reason: row.cancellation_reason }),
          },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = error.code;
  return (
    typeof code === 'string' &&
    (code.startsWith('08') || code === 'ECONNREFUSED' || code === '57P01')
  );
}

function unavailableDatabase(_error: unknown): ProblemError {
  return new ProblemError(
    503,
    'database-unavailable',
    'Database unavailable',
    'Orders database is temporarily unavailable.',
  );
}
