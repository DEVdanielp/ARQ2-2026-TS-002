import { Injectable, Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ProblemError } from '../application/problem-error.js';
import {
  decideIntent,
  type StateEngineOrder,
} from '../application/intent-state-engine.js';
import type {
  IntentMessage,
  ProcessIntentResult,
  StateEngineRepository,
} from '../application/state-engine.port.js';

interface OrderRow {
  order_id: string;
  customer_id: string;
  driver_id: string | null;
  status: StateEngineOrder['status'];
  version: number;
}

@Injectable()
export class PostgresStateEngineRepository implements StateEngineRepository {
  private readonly logger = new Logger(PostgresStateEngineRepository.name);
  private pool?: Pool;

  async processIntent(message: IntentMessage): Promise<ProcessIntentResult> {
    const client = await this.getPool().connect().catch(() => {
      throw databaseUnavailable();
    });
    try {
      await client.query('BEGIN');
      const received = await client.query(
        `INSERT INTO processed_events (
           consumer_name, event_id, topic, partition_number, message_offset
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (consumer_name, event_id) DO NOTHING
         RETURNING event_id`,
        [
          'orders-state-engine',
          message.event.eventId,
          message.topic,
          message.partition,
          message.offset,
        ],
      );
      if (received.rowCount === 0) {
        await client.query('COMMIT');
        return { kind: 'duplicate' };
      }

      const selected = await client.query<OrderRow>(
        `SELECT order_id, customer_id, driver_id, status, version
         FROM orders
         WHERE order_id = $1
         FOR UPDATE`,
        [message.event.aggregateId],
      );
      const order = selected.rows[0];
      if (!order) {
        throw new Error(
          `Order ${message.event.aggregateId} was not found while processing intent ${message.event.eventId}.`,
        );
      }

      const changedAt = new Date().toISOString();
      const decision = decideIntent(
        {
          orderId: order.order_id,
          customerId: order.customer_id,
          driverId: order.driver_id,
          status: order.status,
          version: order.version,
        },
        message.intent,
        changedAt,
      );
      if (decision.kind === 'reject') {
        await this.writeRejectedIntent(client, message, order, decision.reason);
        await client.query('COMMIT');
        return {
          kind: 'rejected',
          reason: decision.reason,
          status: order.status,
        };
      }

      const nextVersion = order.version + 1;
      const cancellation =
        decision.transition.status === 'CANCELLED'
          ? {
              actor: message.intent.actor,
              ...(message.intent.reason === undefined
                ? {}
                : { reason: message.intent.reason }),
            }
          : null;
      await client.query(
        `UPDATE orders
         SET status = $2,
             version = $3,
             cancellation_actor = $4,
             cancellation_reason = $5,
             updated_at = $6
         WHERE order_id = $1`,
        [
          order.order_id,
          decision.transition.status,
          nextVersion,
          cancellation?.actor ?? null,
          cancellation?.reason ?? null,
          changedAt,
        ],
      );

      await client.query(
        `INSERT INTO outbox (
           event_id, topic, aggregate_id, event_type, schema_version,
           occurred_at, correlation_id, aggregate_version, payload
         ) VALUES ($1, 'orders.events', $2, $3, 1, $4, $5, $6, $7::jsonb)`,
        [
          randomUUID(),
          order.order_id,
          decision.transition.eventType,
          changedAt,
          message.event.correlationId,
          nextVersion,
          JSON.stringify(decision.transition.payload),
        ],
      );
      await client.query('COMMIT');
      return {
        kind: 'applied',
        status: decision.transition.status,
        version: nextVersion,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        this.logger.error(
          'Failed to roll back intent state transition',
          rollbackError instanceof Error
            ? rollbackError.stack
            : String(rollbackError),
        );
      });
      if (isConnectionError(error)) {
        throw databaseUnavailable();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private async writeRejectedIntent(
    client: PoolClient,
    message: IntentMessage,
    order: OrderRow,
    reason: string,
  ): Promise<void> {
    const rejectedAt = new Date().toISOString();
    await client.query(
      `INSERT INTO outbox (
         event_id, topic, aggregate_id, event_type, schema_version,
         occurred_at, correlation_id, aggregate_version, payload
       ) VALUES ($1, 'orders.events', $2, 'IntentRejected', 1, $3, $4, NULL, $5::jsonb)`,
      [
        randomUUID(),
        order.order_id,
        rejectedAt,
        message.event.correlationId,
        JSON.stringify({
          orderId: order.order_id,
          intentType: message.intent.type,
          reason,
          rejectedAt,
        }),
      ],
    );
  }

  private getPool(): Pool {
    if (!this.pool) {
      const connectionString = process.env.ORDERS_DATABASE_URL;
      if (!connectionString) {
        throw databaseUnavailable();
      }
      this.pool = new Pool({ connectionString });
    }
    return this.pool;
  }
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

function databaseUnavailable(): ProblemError {
  return new ProblemError(
    503,
    'database-unavailable',
    'Database unavailable',
    'Orders database is temporarily unavailable.',
  );
}
