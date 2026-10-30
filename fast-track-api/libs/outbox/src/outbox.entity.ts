/**
 * The `outbox` table: events waiting to be published to Kafka (ADR-005).
 *
 * How the transactional outbox works
 * ----------------------------------
 * A service must never "save to the database, then publish to Kafka" as two
 * separate steps: if it crashes in between, the database and Kafka disagree
 * (an order DELIVERED with no OrderDelivered event). Instead it INSERTS the
 * event into this table inside the SAME transaction as its business change.
 * Either both are committed or neither is. A background relay (OutboxRelay)
 * later reads pending rows, publishes them and marks them as published.
 *
 * `publish_after` (ADR-017) is optional: when set, the relay waits until that
 * moment before publishing. This is how delayed retries are scheduled.
 *
 * Each service owns its own `outbox` table, in its own database (ADR-003).
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EventEnvelope } from '@libs/events';

@Entity({ name: 'outbox' })
export class OutboxEntity {
  /** Increasing id: rows are published in insertion order. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Destination topic, e.g. `notifications.retry`. */
  @Column({ type: 'text' })
  topic: string;

  /** Kafka key (decides the partition and therefore the ordering). */
  @Column({ name: 'message_key', type: 'text' })
  messageKey: string;

  /** The complete envelope, created when the fact happened (same eventId on every re-send). */
  @Column({ type: 'jsonb' })
  envelope: EventEnvelope;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  /** Do not publish before this moment; null = as soon as possible. */
  @Column({ name: 'publish_after', type: 'timestamptz', nullable: true })
  publishAfter: Date | null;

  /** When Kafka confirmed the write; null = still pending. */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /** Publish attempts (including failed ones). */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  /** Error of the last failed attempt, for troubleshooting. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;
}
