# Orders Service (F4)

The state engine and source of truth of the order status. It receives intents
over REST, queues them per order in Kafka and applies only valid transitions;
it is the only component that changes an order's status (ADR-016). Owns
`orders-db`. Contract: `docs/spec.md` §1, §4.2, §5.4, F4. Decisions:
[ADR-005](../../../docs/adrs/005-transactional-outbox.md),
[ADR-006](../../../docs/adrs/006-order-intents-rest-to-kafka.md),
[ADR-009](../../../docs/adrs/009-at-least-once-idempotent-consumers.md),
[ADR-016](../../../docs/adrs/016-order-fulfillment-saga-choreography.md).

## Structure (hexagonal, ADR-014)

```
src/
  domain/order.ts        the aggregate and its state machine: who may do what, and when
  application/           use cases + ports (what they need from outside)
    ports.ts               OrdersStore with transactional sessions, IntentPublisher, Clock
    orders.use-cases.ts    REST: create, get, list, submit intent (pre-checks)
    state-engine.use-cases.ts  Kafka: apply intents, record/clear the driver; cleanup
    idempotency.ts         Idempotency-Key: same key → same response for 24 h
    events.ts              the events this service publishes
    testing/in-memory.ts   fake store, publisher and clock, for unit tests
  adapters/
    in/http/             REST controller + DTOs + Swagger (spec §4.2)
    in/kafka/            orders.intents and assignment.events consumer
    in/scheduler/        hourly cleanup of expired keys and processed ids
    out/persistence/     PostgreSQL store (SQL), migration
    out/kafka/           publishes intents to orders.intents
  config/                environment validation
  orders-service.module.ts   binds every port to its implementation
test/                    integration tests against a real PostgreSQL
```

Dependencies point inward: adapters → application → domain.

## How it works

**REST** (behind Kong, `/v1/...`; role checked by `@libs/auth`, ids from the JWT `sub`):

| Endpoint | Role | What it does |
| --- | --- | --- |
| `POST /orders` | CUSTOMER | creates the order in `CREATED`; `OrderCreated` through the outbox; `201` + `Location` |
| `GET /orders/{orderId}` | owner CUSTOMER, assigned DRIVER, OPERATIONS | the order (`403` for anyone else) |
| `GET /orders?status=&page=&size=` | any | own / assigned / all orders, newest first (`size` 1–100, default 20) |
| `POST /orders/{orderId}/intents` | see below | pre-checks, publishes the intent to `orders.intents`, `202 QUEUED` |

| Intent | Who | Transition |
| --- | --- | --- |
| `PICKUP_CONFIRMED` | assigned DRIVER | `CREATED → ON_THE_WAY` |
| `DELIVERY_CONFIRMED` | assigned DRIVER | `ON_THE_WAY → DELIVERED` |
| `CANCELLATION_REQUESTED` | owner CUSTOMER | `CREATED → CANCELLED` |
| `CANCELLATION_REQUESTED` + `reason` | OPERATIONS | `CREATED` / `ON_THE_WAY → CANCELLED` |

The REST checks (`403`, `409` terminal) only spare a round trip. The state
engine decides again when it consumes the intent, against the locked row,
because the order may have changed in between (for example `DriverUnassigned`).

**Events consumed** (group `orders-service`):

| Topic | Event | Effect |
| --- | --- | --- |
| `orders.intents` | `PickupConfirmed`, `DeliveryConfirmed`, `CancellationRequested` | apply (new status, `version + 1`, event) or reject (recorded in `rejected_intents`, never retried) |
| `assignment.events` | `DriverAssigned` | records the driver, `version + 1`; ignored unless `CREATED` (F4-S9) |
| `assignment.events` | `DriverUnassigned` | clears the driver if it is still theirs and the order is `CREATED` |
| `assignment.events` | `AssignmentFailed` | ignored: the order stays `CREATED` |

**Events produced:**

| Topic (key) | Event | How |
| --- | --- | --- |
| `orders.intents` (orderId) | the three intents | published directly, waiting for Kafka (`503` if it fails); `eventId` = `intentId` |
| `orders.events` (orderId) | `OrderCreated`, `OrderOnTheWay`, `OrderDelivered`, `OrderCancelled` | outbox, same transaction as the change; `aggregateVersion` = order version |
| `orders.events` (orderId) | `IntentRejected` | outbox; see below |

Intents are not published through the outbox: an intent is a request, not a
fact, and the client must learn at once if it was not queued (spec 4.2 `503`).

### `IntentRejected` (spec 5.4)

Spec 4.2 and F4-S6/F4-S8 say a rejection by the state engine is reported in
`TrackingView.lastRejectedIntent`, and the view is built only from events. So
the engine stores the rejection in `rejected_intents` and publishes:

```json
{ "orderId": "6f1c…", "intentId": "c2d4…",
  "lastRejectedIntent": { "type": "PICKUP_CONFIRMED", "reason": "Only the driver assigned to the order may confirm it.", "at": "2026-10-18T15:30:00Z" } }
```

It is additive (spec 5.2): every current consumer of `orders.events` ignores
event types it does not know. It does not change the order, so its
`aggregateVersion` repeats the current one. **Pending:** the Tracking Query
Service does not project it into the view yet.

## Idempotency

| Mechanism | Where |
| --- | --- |
| `Idempotency-Key` (UUID, optional) on both POSTs | `idempotency_keys`, per user and endpoint, 24 h; same key + other body → `409`. Parallel requests with one key wait on an advisory lock |
| Intents | `processed_events` by `intentId`. With a key the `intentId` is derived from it, so a client retry after a crash publishes the same id (F4-S7) |
| Assignment events | `processed_events` by `eventId` |

An hourly job deletes expired keys and processed ids older than 7 days.

## orders-db

Created by the TypeORM migration on startup: `orders`, `rejected_intents`,
`idempotency_keys`, `processed_events`, plus `outbox` from `@libs/outbox`.
`orders` keeps the destination in columns and refuses at the database level a
cancelled order without actor, or an operations cancellation without reason.

## Run and test

In Docker (from `fast-track-api/`): `docker compose --profile apps up -d --build`.
Swagger: the team's Swagger UI at <http://localhost:8090> ("Orders Service").

```bash
npx vitest run apps/orders-service            # unit + HTTP + Kafka adapter tests
```

Refresh `docs/openapi/orders-service.json` (shown by the team's Swagger UI) after
changing the API:

```bash
npx nest build orders-service && node --env-file=apps/orders-service/.env.example dist/apps/orders-service/main.js --openapi ../docs/openapi/orders-service.json
```

Integration tests against PostgreSQL (in a throw-away schema):

```powershell
$env:TEST_DATABASE_URL = "postgres://orders_db:fasttrack@localhost:5432/orders_db"
npm run test:e2e
```

On the host, copy `.env.example` to `.env` and run
`npx nest build orders-service; node dist/apps/orders-service/main.js` (port 3040,
Swagger at <http://localhost:3040/v1/orders/docs>).
