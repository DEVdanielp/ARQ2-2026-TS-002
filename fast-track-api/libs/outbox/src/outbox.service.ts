/**
 * OutboxService: how business code "publishes" an event reliably.
 *
 * Instead of calling Kafka, a use case calls `enqueue()` with the SAME
 * EntityManager (transaction) it uses for its business changes:
 *
 *   await dataSource.transaction(async (manager) => {
 *     await manager.update(OrderEntity, { id }, { status: 'DELIVERED' });
 *     await outbox.enqueue(manager, { topic: Topics.ORDERS_EVENTS, key: id, envelope });
 *   });
 *
 * If the transaction rolls back, the event disappears with it; if it commits,
 * the relay will publish the event, even if the process crashes right after.
 */
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { DlqTopic, EventEnvelope, Topic } from '@libs/events';

/** An event to publish later. */
export interface OutboxMessage<TPayload = unknown> {
  topic: Topic | DlqTopic;
  /** Kafka key, as required by spec 5.1 for the topic. */
  key: string;
  /** Created once with `createEnvelope()`; re-sends keep its eventId (ADR-009). */
  envelope: EventEnvelope<TPayload>;
  /** Optional: do not publish before this moment (ADR-017). */
  publishAfter?: Date;
}

@Injectable()
export class OutboxService {
  /**
   * Stores the event in the `outbox` table using the caller's transaction.
   *
   * @param manager - the EntityManager of the caller's transaction. Passing a
   *   manager from outside the transaction would defeat the purpose.
   */
  async enqueue<TPayload>(manager: EntityManager, message: OutboxMessage<TPayload>): Promise<void> {
    if (!message.key) {
      throw new Error(`Outbox message for ${message.topic} has no key: ordering is per key (ADR-001)`);
    }
    // Plain SQL: the envelope is stored as JSON and its payload type does not
    // matter to the outbox (TypeORM's typed insert does not model that well).
    await manager.query(
      `INSERT INTO outbox (topic, message_key, envelope, publish_after) VALUES ($1, $2, $3, $4)`,
      [message.topic, message.key, JSON.stringify(message.envelope), message.publishAfter ?? null],
    );
  }
}
