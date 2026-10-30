/**
 * OutboxRelay: background loop that moves pending outbox rows to Kafka.
 *
 * Every `pollIntervalMs` (≈200 ms, ADR-005) it opens a transaction, locks a
 * batch of due rows, publishes them in order and marks them as published.
 * Once a minute it also deletes rows published more than `retentionHours`
 * ago, so the table does not grow forever (ADR-005, negatives).
 *
 * Locking: `FOR UPDATE SKIP LOCKED` lets several instances of a service run
 * relays at the same time without publishing the same row twice: each one
 * skips the rows another has locked. Caveat: with several instances, two rows
 * of the same key can be taken by different relays and published out of
 * order. With one instance per service (our setup) order is preserved.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { KafkaProducerService } from '@libs/kafka';
import { publishOutboxBatch, type OutboxStore, type PendingOutboxRow } from './outbox-publisher.js';

export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

export interface OutboxOptions {
  /** Wait between polls when there was nothing (more) to publish. */
  pollIntervalMs: number;
  /** Rows per transaction. */
  batchSize: number;
  /** Published rows older than this are deleted. */
  retentionHours: number;
  /** Set to false to disable the relay (e.g. in tests). */
  enabled: boolean;
}

const CLEANUP_EVERY_MS = 60_000;

/** SQL implementation of the store, bound to one transaction. */
function sqlStore(manager: EntityManager): OutboxStore {
  return {
    async claimDue(limit) {
      const rows: Array<{ id: string; topic: string; message_key: string; envelope: PendingOutboxRow['envelope'] }> =
        await manager.query(
          `SELECT id, topic, message_key, envelope
             FROM outbox
            WHERE published_at IS NULL
              AND (publish_after IS NULL OR publish_after <= now())
            ORDER BY id
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        );
      return rows.map((row) => ({
        id: String(row.id),
        topic: row.topic,
        messageKey: row.message_key,
        envelope: row.envelope,
      }));
    },
    async markPublished(id) {
      await manager.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [id]);
    },
    async markFailed(id, error) {
      await manager.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [id, error]);
    },
  };
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private wakeUp?: () => void;
  private lastCleanup = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly producer: KafkaProducerService,
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
  ) {}

  /** Starts after every module is initialised, so the producer is connected. */
  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    this.loop = this.run();
    this.logger.log(`Outbox relay started (every ${this.options.pollIntervalMs} ms)`);
  }

  /** Stops polling and waits for the current batch, so no row is left half-processed. */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
  }

  /** Publishes due rows until none are left; exposed for tests and manual triggers. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await this.dataSource.transaction((manager) =>
        publishOutboxBatch(sqlStore(manager), this.producer, this.options.batchSize),
      );
      total += result.published;
      // Stop on failure (retry next tick) or when the batch was not full.
      if (result.failed || result.published < this.options.batchSize) return total;
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.drain();
        await this.cleanupIfDue();
      } catch (error) {
        // A database or Kafka outage must not kill the loop; try again later.
        this.logger.error(`Outbox relay iteration failed: ${(error as Error).message}`);
      }
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  private async cleanupIfDue(): Promise<void> {
    if (Date.now() - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = Date.now();
    await this.dataSource.query(
      `DELETE FROM outbox WHERE published_at < now() - make_interval(hours => $1)`,
      [this.options.retentionHours],
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
