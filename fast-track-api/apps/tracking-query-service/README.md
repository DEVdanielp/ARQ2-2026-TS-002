# Tracking Query Service (F3)

CQRS read side of FastTrack. Builds **one view per order in Redis** from
events, serves it over REST and **Server-Sent Events**, and serves the **route
audit** from its archive. It never changes an order (Orders is the only source
of truth for the status). Owns `tracking-cache` (Redis) and `query-archive-db`
(PostgreSQL). Contract: `docs/spec.md` §4.4, §5.4, F3; ADR-002, ADR-004, ADR-010.

## Structure (hexagonal, ADR-014)

```
src/
  domain/
    tracking-view.ts     TrackingView (spec §3), read-time rules (locationAgeSeconds,
                         trackingAvailable) and who may read a view
    view-change.ts       the change each event makes, and the guards that apply to it
  application/           use cases + ports
    ports.ts               TrackingViewStore, ViewChangeBus, TrackingArchive, settings
    project-tracking-event.ts  event -> view (+ archive, + Pub/Sub)  ("ProjectEventHandler", ADR-004)
    get-tracking-view.ts   GET /tracking/{orderId}: Redis, then archive after 24 h
    watch-tracking-view.ts SSE logic (Last-Event-ID, no older view after a newer one)
    get-route.ts           route audit with from/to
    testing/in-memory.ts   fakes of every port, for unit tests
  adapters/
    in/http/             REST + SSE controller, Swagger DTOs (spec §4.4)
    in/kafka/            consumer: turns each event into a ViewChange
    out/redis/           view store (hash + Lua script), Pub/Sub bus, connection
    out/persistence/     query-archive-db: migration + SQL archive
  config/                environment validation
  tracking-query-service.module.ts   binds every port to its implementation
```

Dependencies point inward: adapters → application → domain.

## How it works

**Events consumed** (group `tracking-query-service`, one subscription per topic):

| Topic | Event | Effect on the view | Applied only if |
| --- | --- | --- | --- |
| `orders.events` | `OrderCreated` | creates it: `CREATED`, owner, destination, `assignmentStatus = PENDING` | version > stored |
| `orders.events` | `OrderOnTheWay` / `OrderDelivered` / `OrderCancelled` | status; terminal -> 24 h expiry | `aggregateVersion` > stored (F3-S4) |
| `assignment.events` | `DriverAssigned` | driver + name, `ASSIGNED` | order not terminal |
| `assignment.events` | `DriverUnassigned` | driver cleared, `PENDING` | same driver, order still `CREATED` |
| `assignment.events` | `AssignmentFailed` | `FAILED` (status unchanged) | order not terminal |
| `tracking.locations` | `LocationUpdated` | last location; point archived for the route | `sequence` > stored, order not terminal |
| `tracking.proximity` | `DriverNearDestination` | `nearbyReached = true` | not reached yet |

Events of one order travel on different topics and may arrive in any order;
the guards make that harmless (a location that arrives before `OrderCreated` is
kept; the view becomes visible once the order is known).

**Redis view** (`tracking:view:{orderId}`, hash). Every write goes through one
Lua script (`adapters/out/redis/apply-view-change.lua.ts`), so the compare and
the write are atomic even with several instances (ADR-010). Each applied change
increases the view `revision` (used as the SSE event id) and publishes the
order id on the channel `tracking:changes`. Active orders never expire;
`DELIVERED`/`CANCELLED` expire after `TERMINAL_VIEW_TTL_SECONDS` (24 h, ADR-002).

**Archive** (`query-archive-db`):
- `order_snapshots`: copy of the view on every order / assignment / NEARBY
  change (newest `revision` wins). Serves `GET /tracking/{orderId}` once the
  Redis key expired (F3-S5).
- `route_points`: every `LocationUpdated`, once per `(order, sequence)`.
  Serves the route audit.

**Read-time rule** (F3-S2/S3): `locationAgeSeconds` = now − `lastLocationDeviceTime`;
`trackingAvailable` = there is a location and it is less than 300 s old. The
status is never changed for this reason.

## REST API (behind Kong, `http://localhost:8000`)

| Endpoint | Role | Notes |
| --- | --- | --- |
| `GET /v1/tracking/{orderId}` | `CUSTOMER` (owner) or `OPERATIONS` | `200` TrackingView · `403` · `404` · `503` Redis down |
| `GET /v1/tracking/{orderId}/stream` | `CUSTOMER` (owner) or `OPERATIONS` | SSE: `event: tracking`, `id` = revision, `: heartbeat` every 15 s, `Last-Event-ID` on reconnection, token also as `?jwt=` |
| `GET /v1/tracking/{orderId}/route?from&to` | `OPERATIONS` | points ordered by `sequence`; `from`/`to` optional ISO-8601 with zone; `400` invalid range |

Swagger UI: <http://localhost:8090> (team UI, "Tracking Query Service") or
`/v1/tracking/docs` on the service. Regenerate the exported document after
changing the API:

```bash
npm run openapi:tracking-query-service   # writes ../docs/openapi/tracking-query-service.json
```

## Run and try it

```bash
docker compose --profile apps up -d --build tracking-query-service
```

1. Get a token (users of `deploy/keycloak/fasttrack-realm.json`, password `password`):
   ```bash
   curl -s -X POST http://localhost:8180/realms/fasttrack/protocol/openid-connect/token \
     -d grant_type=password -d client_id=<client> -d username=ops1 -d password=password
   ```
2. Publish an `OrderCreated` (and later `LocationUpdated`, `OrderDelivered`, …)
   to the topics above from Kafka UI (<http://localhost:8085>, *Topics* → *Produce
   Message*, key = `orderId`, value = an `EventEnvelope` from spec §5.4).
3. `GET /v1/tracking/{orderId}` with `Authorization: Bearer <token>`, or keep the
   stream open: `curl -N -H "Authorization: Bearer <token>" http://localhost:8000/v1/tracking/{orderId}/stream`.

Inspect the view: `docker compose exec redis redis-cli HGETALL tracking:view:<orderId>`.

## Tests

```bash
npx vitest run apps/tracking-query-service        # unit: domain, use cases, payloads, HTTP + SSE
```

Integration (real Redis and PostgreSQL of the local stack; skipped without the variables):

```bash
$env:TEST_REDIS_URL = "redis://localhost:6379/15"
$env:TEST_ARCHIVE_DATABASE_URL = "postgres://query_archive_db:fasttrack@localhost:5432/query_archive_db"
npm run test:e2e -- apps/tracking-query-service
```

The Redis test covers the Lua guards (no regression, sequences, terminal
expiry, assignment) and Pub/Sub; the PostgreSQL test runs in a throw-away schema.

## Notes

- `lastRejectedIntent` is part of the spec's `TrackingView`, but no event of
  spec §5.4 carries rejected intents to this service yet, so it is always `null`.
- `trackingAvailable` turning false after 5 minutes without points is computed
  when the view is read; the SSE stream sends views on changes only, so clients
  should also use `lastLocationDeviceTime` to show "Tracking temporarily unavailable".
- The token is decoded, not verified, by the service (Kong verifies it); see
  `libs/auth/README.md`.
