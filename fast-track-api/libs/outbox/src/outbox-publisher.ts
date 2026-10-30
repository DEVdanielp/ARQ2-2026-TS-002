/**
 * publishOutboxBatch: the relay's core loop for ONE batch, kept free of
 * database and Kafka code so it can be unit-tested with fakes.
 *
 * Rules
 * -----
 * - Rows are published in id order (insertion order), so events of the same
 *   key keep their order (ADR-001).
 * - A row is marked as published only after Kafka confirmed the write
 *   (`publish()` waits for acks=all). If the process dies before marking it,
 *   the row is published again later: at-least-once, which is why consumers
 *   are idempotent and why the envelope keeps its eventId (ADR-009).
 * - On the first failure the batch stops: publishing later rows would let them
 *   overtake the failed one. The failed row is retried on the next tick.
 */
import type { DlqTopic, EventEnvelope, Topic } from '@libs/events';

/** A pending row, as read by the relay. */
export interface PendingOutboxRow {
  id: string;
  topic: string;
  messageKey: string;
  envelope: EventEnvelope;
}

/** Storage operations the batch needs (implemented with SQL by the relay). */
export interface OutboxStore {
  /** Locks and returns up to `limit` due rows, oldest first. */
  claimDue(limit: number): Promise<PendingOutboxRow[]>;
  markPublished(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

/** The part of KafkaProducerService the relay uses. */
export interface OutboxPublisherPort {
  publish(topic: Topic | DlqTopic, key: string, envelope: EventEnvelope): Promise<unknown>;
}

export interface BatchResult {
  published: number;
  failed: boolean;
}

export async function publishOutboxBatch(
  store: OutboxStore,
  producer: OutboxPublisherPort,
  limit: number,
): Promise<BatchResult> {
  const rows = await store.claimDue(limit);
  let published = 0;

  for (const row of rows) {
    try {
      await producer.publish(row.topic as Topic | DlqTopic, row.messageKey, row.envelope);
    } catch (error) {
      await store.markFailed(row.id, error instanceof Error ? error.message : String(error));
      return { published, failed: true };
    }
    await store.markPublished(row.id);
    published++;
  }
  return { published, failed: false };
}
