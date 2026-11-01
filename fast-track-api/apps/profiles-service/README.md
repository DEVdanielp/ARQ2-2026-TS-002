# Profiles & Assignment Service (F1)

Customer and driver profiles, driver availability and capacity, and the
assignment of every new order to an available driver: step 2 of the order
fulfillment saga (ADR-016). Owns `profiles-db`. Contract: `docs/spec.md` §4.1,
§5.4, F1. Implementation decisions: [ADR-019](../../../docs/adrs/019-driver-assignment-rules.md).

## Structure (hexagonal, ADR-014)

```
src/
  domain/              vocabulary (spec §3) and pure rules
    driver-rules.ts      eligibility, choice of driver, availability, capacity check
    customer-rules.ts    when CustomerContactUpdated is published
    assignment-window.ts 30 s retries, 10-minute window
  application/         use cases + ports (what they need from outside)
    ports.ts             ProfilesStore with transactional "sessions", Clock, settings
    assignment.use-cases.ts   OrderCreated, retries, order status (the saga)
    driver-profile.use-cases.ts  driver profile, availability (OFFLINE -> DriverUnassigned), capacity, GET assignment
    customer-profile.use-cases.ts
    events.ts            the 4 events this service publishes
    testing/in-memory.ts fake store and clock, for unit tests
  adapters/
    in/http/           REST controllers + DTOs + Swagger (spec §4.1)
    in/kafka/          orders.events consumer
    in/scheduler/      timer that runs the due assignment retries
    out/persistence/   PostgreSQL store (SQL), migration
  config/              environment validation
  profiles-service.module.ts   binds every port to its implementation
test/                  integration tests against a real PostgreSQL
```

Dependencies point inward: adapters → application → domain.

## How it works

**REST** (behind Kong, `/v1/...`; role checked by `@libs/auth`, ids from the JWT `sub`):

| Endpoint | Role | What it does |
| --- | --- | --- |
| `GET /customers/me` | CUSTOMER | the caller's profile (404 before it exists) |
| `PUT /customers/me` | CUSTOMER | create (201) / replace (200); publishes `CustomerContactUpdated` on create or email/phone change |
| `PUT /drivers/me` | DRIVER | create (201, `OFFLINE`, capacity 3) / update name, phone, plate (200) |
| `PATCH /drivers/me/availability` | DRIVER | `AVAILABLE` / `OFFLINE`; 409 with an order `ON_THE_WAY`; releases `CREATED` orders |
| `PATCH /drivers/{driverId}/capacity` | OPERATIONS | 1–10; 409 below the active orders |
| `GET /assignments?orderId=` | OPERATIONS | current or latest assignment of the order |

**Events consumed** (`orders.events`, group `profiles-service`):

| Event | Effect |
| --- | --- |
| `OrderCreated` | store the order + destination (`assignment_requests`); try to assign at once |
| `OrderOnTheWay` | the order is picked up: its driver can no longer go `OFFLINE` |
| `OrderDelivered` / `OrderCancelled` | release the slot (`AVAILABLE` again with no active orders); stop retries |

**Events produced** (through `@libs/outbox`, same transaction as the change):

| Topic (key) | Event | When |
| --- | --- | --- |
| `assignment.events` (orderId) | `DriverAssigned` | driver chosen; payload carries `driverName`, `destination.location`, `assignedAt` |
| `assignment.events` (orderId) | `DriverUnassigned` | driver went `OFFLINE` before pickup (`reason: DRIVER_OFFLINE`) |
| `assignment.events` (orderId) | `AssignmentFailed` | no driver within the 10-minute window; order stays `CREATED` |
| `profile.events` (customerId) | `CustomerContactUpdated` | profile created, or email/phone changed; `aggregateVersion` = contact version |

**Choosing a driver** (ADR-019): eligible = not `OFFLINE` and fewer active
orders than the capacity (`EN_ROUTE` drivers with a free slot included). Among
them: fewest active orders, then the oldest last assignment, then the lowest id.

**When nobody is eligible:** the order stays `PENDING` with
`next_attempt_at = now + 30 s`. The scheduler checks every second for due
attempts. When an attempt is due 10 minutes after the window started,
`AssignmentFailed` is published instead (`attempts` = 20 with the defaults) and
no more attempts are made. Because the due times are rows, a restart loses no
retry.

**Driver goes OFFLINE:** refused with 409 if one of their orders is
`ON_THE_WAY`. Otherwise, for every order still `CREATED`: release →
`DriverUnassigned` → new 10-minute window → immediate attempt with the other
drivers. In the outbox, `DriverUnassigned` is always before the new
`DriverAssigned` of the same order, and its time is strictly earlier (1 ms),
because consumers drop an assignment event that is not newer than the last one.

**Consistency:** every assignment change runs in one transaction holding a
single advisory lock (no driver can exceed its capacity, no deadlocks);
consumed events are deduplicated by `eventId` (`processed_events`) and applied
by `aggregateVersion`; at most one active assignment per order (partial
`UNIQUE` index).

## API documentation (Swagger)

| Where | URL |
| --- | --- |
| Shared Swagger UI (Docker, whole team) | <http://localhost:8090> → *Profiles & Assignment Service* |
| Served by the service (host run) | <http://localhost:3050/v1/profiles/docs> (JSON: `.../docs-json`) |
| Versioned file | [`docs/openapi/profiles-service.json`](../../../docs/openapi/profiles-service.json) |

The document covers the 6 endpoints, request/response schemas with examples,
roles, every error status with a problem+json example, and a summary of the
Kafka events consumed and produced. After changing an endpoint or DTO,
regenerate the file (no database or Kafka needed) and commit it:

```powershell
npm run openapi:profiles-service
```

*Try it out* in the shared UI: pick the Kong server, click **Authorize** and
paste a token from Keycloak (`customer1`, `driver1`, `driver2` or `ops1`, password `password`):

```powershell
(Invoke-RestMethod -Method Post "http://localhost:8180/realms/fasttrack/protocol/openid-connect/token" -Body @{ grant_type='password'; client_id='fasttrack-dev'; username='driver1'; password='password' }).access_token
```

`SWAGGER_ENABLED=false` turns off the UI served by the service.

## Configuration

Validated at startup (`src/config/environment.ts`); the service refuses to
start if a variable is missing or invalid.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | profiles-db connection string |
| `KAFKA_BROKERS` | read by `@libs/kafka` (defaults to `localhost:9092`) |
| `ASSIGNMENT_RETRY_SECONDS` | optional, default `30` |
| `ASSIGNMENT_WINDOW_SECONDS` | optional, default `600` (10 min) |
| `ASSIGNMENT_SCHEDULER_INTERVAL_MS` | optional, default `1000` |
| `DEFAULT_DRIVER_CAPACITY` | optional, default `3` |
| `PORT` / `port` | HTTP port (default 3000; 3050 in `.env.example`) |

## Database

Migrations run automatically on startup (`synchronize` is off). To change the
schema, add a migration class and register it in `persistence.module.ts`.

| Table | Purpose |
| --- | --- |
| `customers` | customer profiles; `contact_version` = `aggregateVersion` of `CustomerContactUpdated` |
| `drivers` | driver profiles, availability, capacity, `last_assigned_at` (tie-breaker) |
| `assignment_requests` | one row per order: destination, status/version, `PENDING`/`ASSIGNED`/`FAILED`, attempts, window, next attempt |
| `assignments` | who had which order and when; one active per order; `activeOrderIds` is derived from it |
| `processed_events` | handled `eventId`s (ADR-009) |
| `outbox` | events waiting to be published, from `@libs/outbox` |

Browse it in pgAdmin: <http://localhost:5050> → `profiles_db`.

## Run and try it

```powershell
cd fast-track-api
docker compose up -d postgres kafka kafka-init kafka-ui
Copy-Item apps/profiles-service/.env.example apps/profiles-service/.env
npx nest build profiles-service
node dist/apps/profiles-service/main.js          # http://localhost:3050/v1/profiles/docs
```

Or in Docker: `docker compose --profile apps up -d --build profiles-service`.

To watch the whole saga in seconds, set `ASSIGNMENT_RETRY_SECONDS=5` and
`ASSIGNMENT_WINDOW_SECONDS=30` in `.env`. Without the Orders Service, publish
`OrderCreated` by hand in Kafka UI (<http://localhost:8085> → Topics →
`orders.events` → Produce message), key = the orderId, value:

```json
{ "eventId": "0f0e0d0c-0b0a-4908-8706-050403020100", "eventType": "OrderCreated", "schemaVersion": 1,
  "occurredAt": "2026-11-01T15:00:00Z", "producer": "orders-service", "correlationId": "0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11",
  "aggregateId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "aggregateVersion": 1,
  "payload": { "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "customerId": "11111111-1111-4111-8111-111111111111",
               "status": "CREATED", "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } } } }
```

Then watch `assignment.events`: with no driver `AVAILABLE` you get
`AssignmentFailed` after the window; with `driver1` registered (`PUT
/drivers/me`) and `AVAILABLE`, you get `DriverAssigned`. Use a new `eventId`
for every message you produce (a repeated one is ignored on purpose).

## Tests and spec scenarios

`npm test` (from `fast-track-api/`): use cases against the in-memory store and
a fake clock; the HTTP adapter with supertest; the Kafka adapter with a fake
consumer. `npm run test:e2e` with `TEST_DATABASE_URL` set also runs
`test/profiles-db.e2e-spec.ts` against a real PostgreSQL (throw-away schema).

| Scenario | Tests |
| --- | --- |
| F1-S1 profile stored under the JWT sub, 201, `CustomerContactUpdated` | `profiles.spec.ts`, `profiles.controllers.spec.ts`, e2e |
| F1-S2 available driver → `DriverAssigned`, order stays `CREATED` | `profiles.spec.ts`, e2e |
| F1-S3 no driver → `PENDING`, retried every 30 s | `profiles.spec.ts`, e2e |
| F1-S3b 10 minutes → `AssignmentFailed`, order stays `CREATED` | `profiles.spec.ts`, e2e |
| F1-S4 full driver gets nothing more (also under concurrency) | `domain.spec.ts`, `profiles.spec.ts`, e2e |
| F1-S5 delivered/cancelled → capacity released, `AVAILABLE` again | `profiles.spec.ts`, e2e |
| F1-S6 `OFFLINE` → `DriverUnassigned` → reassignment; 409 with `ON_THE_WAY` | `profiles.spec.ts`, `profiles.controllers.spec.ts`, e2e |
| F4-S9 cancelled after assignment → driver already released | `profiles.spec.ts` |
| REST 400/401/403/404/409 as problem+json | `profiles.controllers.spec.ts` |
