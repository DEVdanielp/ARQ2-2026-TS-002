# @libs/kafka

Shared Kafka producer and consumer for every FastTrack service. It applies the
rules from `docs/spec.md` §5.1–5.2 and ADR-001/005/009/012 for you, so your
service only has to say *what* to publish and *how* to handle an event.

Event types and topic names live in `@libs/events`.

## 1. Import the module (once per service)

```ts
import { KafkaModule } from '@libs/kafka';

@Module({
  imports: [KafkaModule.forRoot({ clientId: 'orders-service' })], // clientId = your service name
})
export class OrdersServiceModule {}
```

- Brokers come from `KAFKA_BROKERS` (already set in `docker-compose.yml`).
  From your host, the default `localhost:9092` is used.
- The module is global: inject `KafkaProducerService` / `KafkaConsumerService`
  anywhere, with no extra imports.
- Call `app.enableShutdownHooks()` in `main.ts` so connections close cleanly.

## 2. Publish

```ts
import { createEnvelope, Topics } from '@libs/events';
import { KafkaProducerService } from '@libs/kafka';

constructor(private readonly producer: KafkaProducerService) {}

const envelope = createEnvelope({
  eventType: 'OrderCreated',
  schemaVersion: 1,
  producer: 'orders-service',
  correlationId,            // from the X-Correlation-Id header
  aggregateId: orderId,
  aggregateVersion: 1,
  payload: { orderId, customerId /* ... spec §5.4 */ },
});

await this.producer.publish(Topics.ORDERS_EVENTS, orderId, envelope); // key = orderId
```

- **The key is required** and must be the key from spec §5.1 (`driverId` for
  `gps.batches`, `customerId` for `profile.events`, `orderId` for the rest).
  Same key = same partition = processed in order.
- `publish()` throws if Kafka does not confirm the write. Facts that change your
  database must go through the outbox (ADR-005, `@libs/outbox`), which uses
  `publish()` underneath.

## 3. Consume

```ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Topics } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';

@Injectable()
export class OrderEventsConsumer implements OnApplicationBootstrap {
  constructor(private readonly consumer: KafkaConsumerService) {}

  async onApplicationBootstrap() {
    await this.consumer.subscribe({
      topic: Topics.ORDERS_EVENTS,
      groupId: 'notification-service',  // optional, defaults to clientId
      handler: async (envelope, ctx) => {
        // your logic; throw to signal a failure
      },
    });
  }
}
```

## 4. Which `groupId`?

**Your service name** (the default). All instances of a service share the group,
so Kafka splits the partitions among them and each message is handled by one
instance. Every other service has its own group and gets its own copy.
Never reuse another service's groupId: you would steal its messages.

## 5. Guarantees and what you must do

| The library guarantees | So your handler must |
| --- | --- |
| **Order per key**: one message at a time per partition. No order across keys or topics. | Not assume order across topics (use `aggregateVersion` / `sequence`, ADR-009). |
| **At-least-once**: the offset is committed only after your handler succeeds. Nothing is lost, but a message can arrive **twice** (crash, restart, rebalance). | **Be idempotent**: processing the same `eventId` twice must give the same result (`processed_events` table, sequence/version guards, unique constraints). |
| **Retries**: if the handler throws, it is retried after 200 ms, 1 s and 5 s. | Throw on transient errors; keep the handler fast (it blocks its partition while it retries). |

## 6. Dead-letter queue (DLQ)

A message ends up in `<topic>.dlq` (e.g. `gps.batches.dlq`) when:

- the handler failed 4 times (first attempt + 3 retries), or
- the value is not a valid JSON envelope (sent immediately, no retries).

The original message is copied untouched (same key, value and headers), plus
headers explaining the failure: `dlq-reason`, `dlq-error`, `dlq-attempts`,
`dlq-source-topic`, `dlq-source-partition`, `dlq-source-offset`,
`dlq-consumer-group`, `dlq-failed-at`. The source offset is then committed, so
the partition keeps moving. **A message in a DLQ was NOT processed**: someone
must look at it, fix the cause, and replay it if needed.

To see it in **Kafka UI** (<http://localhost:8085>): *Topics* → `gps.batches.dlq`
→ *Messages*. Click a message to see its value and *Headers*.

Try it with the demo: run `gps-tracking-worker` with `DEMO_FAIL_HANDLER=true`
and call `POST /demo/gps-batch` on `gps-ingestion-api`.
