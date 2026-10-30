# Notification Service (F5)

Sends push and email notifications on `ON_THE_WAY`, `NEARBY`, `DELIVERED` and
`CANCELLED` (and `ORDER_CREATED` if the customer opted in), once per type,
order and channel; manages preferences and devices; retries failed sends with
backoff; alerts operations when no driver can be assigned. Owns
`notifications-db`. Contract: `docs/spec.md` §4.5, §5.4, F5.

## Structure (hexagonal, ADR-014)

```
src/
  domain/              vocabulary (types from spec §3) and the channel-selection rule
  application/         use cases + ports (interfaces they need from the outside)
    ports.ts             repositories, EmailSender, PushSender, settings
    notify-customer.ts   first send of a notification (core)
    retry-notification.ts  RetryConsumer logic
    retry-policy.ts      what happens after a failure (retry or dead-letter)
    ...                  preferences, replication, operations alert, log query
    testing/in-memory.ts fakes of every port, for unit tests
  adapters/
    in/http/           REST controller + DTOs (spec §4.5)
    in/kafka/          event consumer: routes each event to a use case
    out/persistence/   TypeORM entities, migrations, repositories
    out/email/         EmailSender over SMTP (MailHog locally)
    out/push/          PushSender over FCM, or log-only without credentials
  config/              environment validation
  notification-service.module.ts   binds every port to its implementation
```

Dependencies point inward: adapters → application → domain.

## How it works

**Events consumed** (group `notification-service`, one subscription per topic):

| Topic | Event | Effect |
| --- | --- | --- |
| `orders.events` | `OrderCreated` | store `orderId → customerId`; notify `ORDER_CREATED` if opted in |
| `orders.events` | `OrderOnTheWay` / `OrderDelivered` / `OrderCancelled` | notify `ON_THE_WAY` / `DELIVERED` / `CANCELLED` |
| `tracking.proximity` | `DriverNearDestination` | notify `NEARBY` (skipped if the order is already delivered/cancelled) |
| `profile.events` | `CustomerContactUpdated` | store contact if `aggregateVersion` is newer |
| `assignment.events` | `AssignmentFailed` | email to `OPS_ALERT_EMAIL` (once per `eventId`) |
| `notifications.retry` | `NotificationRetry` | retry the failed channel |

**Sending a notification** (`NotifyCustomer`): find the customer → read
preferences (defaults if none) → choose channels (`push` needs a device, `email`
needs a contact; disabled = never) → for each channel insert the
`notification_log` row as `PENDING` (`UNIQUE(order_id, type, channel)`: a
duplicate event finds the row and stops) → send → `SENT`.

**When a provider fails** (ADR-017): in one transaction the row becomes
`RETRYING` and a `NotificationRetry` is written to the outbox with
`publish_after = now + 1 min`. The relay publishes it when due; the retry
consumer tries again at once. Waits: 1 min, 5 min, 15 min. If the 3rd retry
fails: `DEAD_LETTERED` (attempts = 4) and the message goes to
`notifications.retry.dlq`. Provider failures never block the Kafka partition.

**Errors that DO block briefly** (retried by `@libs/kafka`, then `<topic>.dlq`):
an event for an order whose `OrderCreated` was not processed yet, an invalid
payload, a database outage, or an SMTP failure while alerting operations.

## API documentation (Swagger)

| Where | URL |
| --- | --- |
| Shared Swagger UI (Docker, whole team) | <http://localhost:8090> → *Notification Service* |
| Served by the service (host run) | <http://localhost:3020/v1/notifications/docs> (JSON: `.../docs-json`) |
| Versioned file | [`docs/openapi/notification-service.json`](../../../docs/openapi/notification-service.json) |

The document covers the 4 endpoints, request/response schemas, roles, the
problem+json errors and a summary of the Kafka events consumed and produced.
After changing an endpoint or DTO, regenerate the file (no database or Kafka
needed) and commit it:

```powershell
npm run openapi:notification-service
```

*Try it out* in the shared UI: pick the Kong server, click **Authorize** and
paste a token from Keycloak:

```powershell
(Invoke-RestMethod -Method Post "http://localhost:8180/realms/fasttrack/protocol/openid-connect/token" -Body @{ grant_type='password'; client_id='fasttrack-dev'; username='customer1'; password='password' }).access_token
```

`SWAGGER_ENABLED=false` turns off the UI served by the service.

## Configuration

Validated at startup (`src/config/environment.ts`); the service refuses to
start if a variable is missing or invalid.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | notifications-db connection string |
| `KAFKA_BROKERS` | read by `@libs/kafka` (defaults to `localhost:9092`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | email provider |
| `FCM_CREDENTIALS_FILE` | Firebase service-account JSON; empty = push is only logged |
| `OPS_ALERT_EMAIL` | mailbox for `AssignmentFailed` alerts |
| `NOTIFICATION_RETRY_BACKOFF_SECONDS` | optional, default `60,300,900`; e.g. `5,10,15` to test locally |
| `PORT` / `port` | HTTP port (default 3000) |

## Database

Migrations run automatically on startup (`synchronize` is off). To change the
schema, add a migration class and register it in `persistence.module.ts`.

| Table | Purpose |
| --- | --- |
| `preferences` | channel preferences per customer |
| `contacts` | copy of contact data from `CustomerContactUpdated` (ADR-015) |
| `devices` | push device tokens (key: token) |
| `order_recipients` | `orderId → customerId`, from `OrderCreated` |
| `notification_log` | one row per (order, type, channel); `UNIQUE` = idempotency |
| `processed_events` | handled `eventId`s (operations alerts) |
| `outbox` | events waiting to be published, from `@libs/outbox` |

Browse it in pgAdmin: <http://localhost:5050> → `notifications_db`.

## Run and try it

```powershell
cd fast-track-api
docker compose up -d postgres kafka kafka-init mailhog
Copy-Item apps/notification-service/.env.example apps/notification-service/.env
npx nest build notification-service
node dist/apps/notification-service/main.js          # http://localhost:3020
```

Or in Docker: `docker compose --profile apps up -d --build notification-service`.

Without the other services, publish events by hand in Kafka UI
(<http://localhost:8085> → Topics → `orders.events` → Produce message), with
the `orderId` as key and an `EventEnvelope` as value, in this order:
`CustomerContactUpdated` (profile.events), `OrderCreated`, then
`OrderOnTheWay`. The email appears in MailHog (<http://localhost:8025>); with
no FCM credentials the push is printed in the service log. Stop MailHog
(`docker compose stop mailhog`) to watch `RETRYING` → `DEAD_LETTERED`.

REST without Keycloak: the service only decodes the JWT (Kong verifies it), so
an unsigned token works when calling the service directly (not through Kong).
See `libs/auth/README.md`.

## Tests and spec scenarios

`npm test` (from `fast-track-api/`). Use cases run against in-memory ports;
the HTTP adapter runs with supertest; the Kafka adapter with a fake consumer.

| Scenario | Test |
| --- | --- |
| F5-S1 NEARBY sends push/email by preferences | `notifications.spec.ts` › F5-S3 / F5-S5, consumer › DriverNearDestination |
| F5-S2 no second NEARBY | `notifications.spec.ts` › F5-S2 |
| F5-S3 one notification per type | `notifications.spec.ts` › F5-S3 |
| F5-S4 provider failure → retries → DLQ, nothing blocked | `notifications.spec.ts` › F5-S4 (both) |
| F5-S5 email disabled → never email | `notifications.spec.ts` › F5-S5, `channel-selection.spec.ts` |
| REST, 401/403/404, problem+json | `notifications.controller.spec.ts` |

## Design decisions (recorded in `docs/spec.md` and the ADRs)

- **Whom to notify:** order and tracking events carry no `customerId`, so the
  service always consumes `OrderCreated` and keeps `orderId → customerId`.
- **Claim, then send:** the `PENDING` row is the lock. If the process crashes
  after sending but before marking `SENT`, the redelivered event sends again:
  one duplicate in a crash is the price of at-least-once (ADR-009).
- **Push to several devices** counts as delivered if at least one accepts it.
- **Retries use current data:** a retry reloads contact and devices, so a
  corrected email is used.
- **Operations alerts** are deduplicated by `eventId` and are not part of
  `notification_log`.
