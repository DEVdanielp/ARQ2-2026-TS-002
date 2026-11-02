import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ProblemError } from '../application/problem-error.js';
import type {
  OutboxEvent,
  OutboxRepository,
} from '../application/outbox-port.js';

interface OutboxRow {
  event_id: string;
  topic: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: Date;
  producer: string;
  correlation_id: string;
  aggregate_version: number | null;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  attempts: number;
}

@Injectable()
export class PostgresOutboxRepository implements OutboxRepository {
  private readonly logger = new Logger(PostgresOutboxRepository.name);
  private pool?: Pool;

  async claimPending(limit: number, leaseOwner: string): Promise<OutboxEvent[]> {
    const client = await this.getPool().connect().catch(() => {
      throw databaseUnavailable();
    });
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRow>(
        `WITH eligible AS (
           SELECT candidate.event_id
           FROM outbox AS candidate
           WHERE candidate.published_at IS NULL
             AND candidate.available_at <= now()
             AND (
               candidate.lease_expires_at IS NULL
               OR candidate.lease_expires_at <= now()
             )
             AND NOT EXISTS (
               SELECT 1
               FROM outbox AS earlier
               WHERE earlier.aggregate_id = candidate.aggregate_id
                 AND earlier.published_at IS NULL
                 AND earlier.sequence_id < candidate.sequence_id
             )
           ORDER BY candidate.sequence_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE outbox AS event
         SET lease_owner = $2,
             lease_expires_at = now() + interval '60 seconds'
         FROM eligible
         WHERE event.event_id = eligible.event_id
         RETURNING event.event_id, event.topic, event.aggregate_id,
                   event.event_type, event.schema_version, event.occurred_at,
                   event.producer, event.correlation_id,
                   event.aggregate_version, event.payload, event.headers,
                   event.attempts`,
        [limit, leaseOwner],
      );
      await client.query('COMMIT');
      return result.rows.map(mapEvent);
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        this.logger.error(
          'Failed to roll back outbox claim transaction',
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

  async markPublished(eventId: string, leaseOwner: string): Promise<void> {
    const result = await this.query(
      `UPDATE outbox
       SET published_at = now(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = NULL
       WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL`,
      [eventId, leaseOwner],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Outbox event ${eventId} is no longer owned by this relay.`);
    }
  }

  async markFailed(
    eventId: string,
    leaseOwner: string,
    error: string,
  ): Promise<void> {
    const result = await this.query(
      `UPDATE outbox
       SET attempts = attempts + 1,
           available_at = now() + CASE
             WHEN attempts = 0 THEN interval '200 milliseconds'
             WHEN attempts = 1 THEN interval '1 second'
             WHEN attempts = 2 THEN interval '5 seconds'
             WHEN attempts = 3 THEN interval '15 seconds'
             ELSE interval '30 seconds'
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $3
       WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL`,
      [eventId, leaseOwner, error.slice(0, 2000)],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Outbox event ${eventId} is no longer owned by this relay.`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private async query(sql: string, values: unknown[]) {
    try {
      return await this.getPool().query(sql, values);
    } catch (error) {
      if (isConnectionError(error)) {
        throw databaseUnavailable();
      }
      throw error;
    }
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

function mapEvent(row: OutboxRow): OutboxEvent {
  return {
    eventId: row.event_id,
    topic: row.topic,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    producer: row.producer,
    correlationId: row.correlation_id,
    aggregateVersion: row.aggregate_version,
    payload: row.payload,
    headers: row.headers,
    attempts: row.attempts,
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

function databaseUnavailable(): ProblemError {
  return new ProblemError(
    503,
    'database-unavailable',
    'Database unavailable',
    'Orders database is temporarily unavailable.',
  );
}
