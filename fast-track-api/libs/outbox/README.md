# @libs/outbox

Transactional outbox (ADR-005) with optional delayed publication (ADR-017).
Use it whenever a service **changes its database and publishes an event about
that change**: both commit together, or neither does.

## Setup (once per service)

```ts
import { OUTBOX_ENTITIES, OUTBOX_MIGRATIONS, OutboxModule } from '@libs/outbox';

TypeOrmModule.forRootAsync({
  useFactory: () => ({
    // ...
    entities: [...MY_ENTITIES, ...OUTBOX_ENTITIES],
    migrations: [...MY_MIGRATIONS, ...OUTBOX_MIGRATIONS],   // creates the `outbox` table
    migrationsRun: true,
  }),
}),
KafkaModule.forRoot({ clientId: 'orders-service' }),
OutboxModule.forRoot(),            // starts the relay
```

## Publish through the outbox

```ts
await this.dataSource.transaction(async (manager) => {
  await manager.update(OrderEntity, { id }, { status: 'DELIVERED', version: v + 1 });
  await this.outbox.enqueue(manager, {
    topic: Topics.ORDERS_EVENTS,
    key: id,
    envelope: createEnvelope({ eventType: 'OrderDelivered', /* ... */ }),
  });
});
```

Pass the transaction's `manager`; using any other connection defeats the purpose.

To publish later, add `publishAfter: new Date(...)`: the relay holds the row
until then (used by the Notification Service's retries, ADR-017).

## What the relay does

Every 200 ms it locks a batch of due rows (`FOR UPDATE SKIP LOCKED`), publishes
them **in insertion order** with `KafkaProducerService.publish()` (acks=all,
idempotent), and marks them published. If Kafka fails it stops the batch, so
later rows of the same key cannot overtake, and retries on the next tick.
Published rows older than 7 days are deleted.

Guarantee: **at-least-once**. A crash after publishing but before marking the
row publishes it again; the envelope keeps its `eventId`, so idempotent
consumers drop the duplicate (ADR-009).

Options: `OutboxModule.forRoot({ pollIntervalMs, batchSize, retentionHours, enabled })`.
With several instances of one service, rows of the same key can be published
out of order; we run one instance per service.
