# GPS Tracking Worker (F2, F5)

Processes each driver's GPS points strictly in sequence order, stores the
append-only history, keeps the last known location, publishes it for the
driver's orders on the way and detects proximity (NEARBY). Owns `tracking-db`.
A pure Kafka consumer: **no HTTP API**. Contract: `docs/spec.md` §5.4, F2, F5;
decisions: ADR-001, ADR-009, ADR-011, ADR-013, ADR-015, ADR-018, ADR-020.

## Structure (hexagonal, ADR-014)

```
src/
  domain/              pure rules, no framework
    batch-plan.ts        sort by sequence, drop stored sequences, move forward only
    proximity.ts         haversine distance and the NEARBY rule (500 m / 300 s)
    tracking.ts          order status, monitored order
  application/         use cases + ports
    ports.ts             DriverTrackingStore, RouteOrderRepository, EtaProvider, settings
    process-gps-batch.ts   GpsBatchReceived (core)
    route-orders.use-cases.ts  DriverAssigned / DriverUnassigned / order status
    testing/in-memory.ts fakes of every port, for unit tests
  adapters/
    in/kafka/          consumer (routes events) + payload checks
    out/persistence/   migration, SQL repositories, monthly partitions
    out/eta/           Maps/ETA providers (openrouteservice, OSRM, generic HTTP), quota guard, or distance only
  config/              environment validation
  gps-tracking-worker.module.ts    binds every port to its implementation
```

## How it works

**Events consumed** (group `gps-tracking-worker`, one subscription per topic):

| Topic | Event | Effect |
| --- | --- | --- |
| `gps.batches` | `GpsBatchReceived` | process the batch (below) |
| `assignment.events` | `DriverAssigned` | order joins the driver's route, with its destination (ignored if terminal) |
| `assignment.events` | `DriverUnassigned` | order leaves the route (only if still that driver's and `CREATED`) |
| `orders.events` | `OrderOnTheWay` / `OrderDelivered` / `OrderCancelled` | start / stop monitoring (by `aggregateVersion`) |

**Events produced** (through the outbox, ADR-005):

| Topic | Key | Event | When |
| --- | --- | --- | --- |
| `tracking.locations` | orderId | `LocationUpdated` | the location moved forward: one per monitored order per batch, newest point |
| `tracking.proximity` | orderId | `DriverNearDestination` | first point < 500 m, or ETA < 300 s; once per order |

**Processing a batch** (`ProcessGpsBatch`), for driver D:

1. *(Only with an ETA provider)* ask the ETA for D's monitored orders within
   3 km, at most once per minute per order, before taking any lock (ADR-013).
2. Open a transaction and lock D's row in `driver_routes`: batches of one
   driver never interleave, even across instances.
3. Plan: sort by `sequence`; drop sequences already in `gps_points` (and
   repeats inside the batch) → F2-S4; the new location is the highest
   sequence **if** it is above `last_sequence`.
4. Append the new points to `gps_points` (late ones too: audit, ADR-018).
5. If the location moved: update `driver_routes`; for every monitored order of
   D (assigned + `ON_THE_WAY` + destination known), enqueue `LocationUpdated`
   and run the NEARBY rule over the advancing points; set the flag with
   `WHERE nearby_reached_at IS NULL` and enqueue `DriverNearDestination` only
   if this batch set it (F5-S2).
6. Commit. History, location, flag and events are all-or-nothing.

The worker never changes an order's status (spec §1). Points for a delivered
or cancelled order are stored only (F2-S5).

**Failures:** a handler that throws (database down, invalid payload) is retried
by `@libs/kafka` (200 ms, 1 s, 5 s) and then parked in `<topic>.dlq`. Because
everything is one transaction, a retry starts from a clean state; because every
step is idempotent, a redelivery after a crash changes nothing. An ETA failure
never fails the batch: NEARBY falls back to distance.

## Database (tracking-db)

Migrations run automatically on startup (`synchronize` off). Monthly
partitions of `gps_points` are created at startup and daily (previous, current
and next two months).

| Table | Purpose | Key rules |
| --- | --- | --- |
| `driver_routes` | last known location per driver; the per-driver lock | `last_sequence` only grows |
| `route_orders` | orders on each route (copy from assignment and order events), NEARBY flag, ETA throttle | status by `status_version`; terminal absorbs assignments |
| `gps_points` | append-only history, `PARTITION BY RANGE (device_time)` monthly + `DEFAULT` | `UNIQUE (driver_id, sequence, device_time)`; `CHECK` ranges |
| `processed_events` | eventIds of assignment events applied | PK = idempotency |
| `outbox` | events waiting to be published (`@libs/outbox`) | |

Source of truth: this worker owns the GPS history and the last location;
order status and assignment belong to Orders and Profiles & Assignment (the
copies here only decide what to monitor). Old partitions can be detached and
archived by hand (`ALTER TABLE gps_points DETACH PARTITION gps_points_y2026m01`);
nothing is deleted automatically.

Browse it in pgAdmin: <http://localhost:5050> → `tracking_db`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | tracking-db connection string |
| `KAFKA_BROKERS` | read by `@libs/kafka` (defaults to `localhost:9092`) |
| `NEARBY_DISTANCE_METERS`, `NEARBY_ETA_SECONDS` | NEARBY thresholds (default 500, 300) |
| `ETA_PROVIDER` | `openrouteservice` \| `osrm` \| `http` \| `none`; empty = automatic (see below) |
| `ORS_API_KEY` | openrouteservice key; **secret**, only in `.env` / the shell. Required with `openrouteservice` |
| `ETA_PROVIDER_URL` | `http`: endpoint of the ADR-018 contract; `openrouteservice`/`osrm`: base URL of a self-hosted instance |
| `ETA_ROUTING_PROFILE` | optional: `driving-car` (openrouteservice), `driving` (osrm) |
| `ETA_RATE_LIMIT_PER_MINUTE`, `ETA_DAILY_QUOTA` | optional local caps; default = the provider's free limits (ORS 40 / 2000; OSRM 60 / none); `0` = no cap |
| `ETA_LOOKUP_RADIUS_METERS`, `ETA_MIN_INTERVAL_SECONDS`, `ETA_TIMEOUT_MS` | optional, default 3000, 60, 2000 |

## Maps/ETA provider (ADR-020)

The ETA only feeds the NEARBY rule ("ETA under 5 minutes", F5-S1). It is an
outbound adapter of the `EtaProvider` port, called by `ProcessGpsBatch`
before the batch transaction, only within 3 km of the destination and at most
once per minute per order (ADR-013). The worker exposes no endpoint for it.

| `ETA_PROVIDER` | Adapter | Request | Use |
| --- | --- | --- | --- |
| `openrouteservice` | `OpenRouteServiceEtaProvider` | `POST https://api.heigit.org/openrouteservice/v2/directions/{profile}`, header `Authorization: <ORS_API_KEY>`, body `{ coordinates: [[lng,lat],[lng,lat]], instructions: false, geometry: false }` → `routes[0].summary.duration` (s) | **Selected provider** (free Standard plan: 2 000/day, 40/min) |
| `osrm` | `OsrmEtaProvider` | `GET {base}/route/v1/{profile}/{lng},{lat};{lng},{lat}?overview=false&steps=false` → `routes[0].duration` (s) | Local development and demos without a key (public demo: non-commercial, 1 req/s) or a self-hosted OSRM |
| `http` | `HttpEtaProvider` | `GET {url}?originLat&originLng&destinationLat&destinationLng` → `{ etaSeconds }` | Generic contract of ADR-018 (a proxy) |
| `none` | `DistanceOnlyEtaProvider` | — | NEARBY by distance only |
| *(empty)* | automatic | `ORS_API_KEY` set → `openrouteservice`; `ETA_PROVIDER_URL` set → `http`; else `none` | Backwards compatible |

Every real provider is wrapped in `ResilientEtaProvider`:

- **Quota guard.** It refuses (without calling) above the per-minute and per-24 h caps.
- **Cool-down.** It pauses for 10 min after `401/403` (bad key) and for 60 s after `429`.

**Errors.** All provider errors become `EtaProviderError` with a kind:

| Kind | When |
| --- | --- |
| `TIMEOUT` | no answer within `ETA_TIMEOUT_MS` |
| `NETWORK` | provider unreachable |
| `AUTH` | `401`/`403` |
| `QUOTA` | `429` or the local guard |
| `NO_ROUTE` | no road route between the points (ORS 2004/2009/2010, OSRM `NoRoute`/`NoSegment`) |
| `INVALID_RESPONSE` | `2xx` without a usable duration |
| `UNAVAILABLE` | `5xx`/other |

Whatever the kind, the batch is **not** failed or retried. The worker logs a warning ("ETA provider failed; using distance only"), records the ETA check (so the throttle applies), and NEARBY is decided by distance.

**Get a free key.** Sign up at <https://openrouteservice.org>, create a token in the dashboard, then put `ORS_API_KEY=<token>` in `fast-track-api/.env` (Docker) or `apps/gps-tracking-worker/.env` (host). Both files are git-ignored. On startup the worker logs `ETA provider: openrouteservice (limits: 40 per minute, 2000 per day; ...)`; the key itself is never logged. Credit OpenStreetMap/openrouteservice wherever a route or map is shown to users.

## Run and try it

```powershell
cd fast-track-api
docker compose up -d postgres kafka kafka-init
Copy-Item apps/gps-tracking-worker/.env.example apps/gps-tracking-worker/.env
npx nest build gps-tracking-worker
node dist/apps/gps-tracking-worker/main.js
```

Or in Docker: `docker compose --profile apps up -d --build gps-tracking-worker`.

Without the other services, publish by hand in Kafka UI (<http://localhost:8085>)
with the `orderId` as key: `DriverAssigned` on `assignment.events` (with
`destination.location`), then `OrderOnTheWay` on `orders.events`
(`aggregateVersion: 3`). Then send points with the GPS Ingestion API as that
driver. Watch `tracking.locations` / `tracking.proximity` in Kafka UI and the
tables in pgAdmin.

## Tests and spec scenarios

```powershell
npm test                                   # unit tests (in-memory ports)
$env:TEST_DATABASE_URL = "postgres://tracking_db:fasttrack@localhost:5432/tracking_db"
npm run test:e2e                           # + integration tests on real PostgreSQL
```

The integration tests run in a throw-away schema that is dropped at the end.

| Scenario | Unit test | Integration test (`test/tracking-db.e2e-spec.ts`) |
| --- | --- | --- |
| F2-S3 50 points out of order → sorted, location = highest | `tracking.spec.ts` › F2-S3; `batch-plan.spec.ts` | F2-S3 |
| F2-S4 processed sequences ignored, no regression | `tracking.spec.ts` › F2-S4 (×2) | F2-S4; concurrent batches |
| F2-S5 points after DELIVERED only stored | `tracking.spec.ts` › F2-S5 | F2-S5 |
| F5-S1 NEARBY once (distance / ETA, fallback) | `tracking.spec.ts` › NEARBY; `proximity.spec.ts` | F5-S1/S2 |
| Maps/ETA providers, quota guard, errors (ADR-020) | `adapters/out/eta/*.spec.ts` | `eta-providers.e2e-spec.ts` (live, `ETA_LIVE=1`; real ORS route with `ORS_API_KEY`) |
| F5-S2 no second NEARBY | `tracking.spec.ts` › F5-S2 | F5-S1/S2 |
| Cross-topic order, compensations, dedup | `tracking.spec.ts` › Monitored orders | order replication |
| Rollback on failure | `tracking.spec.ts` › rolls everything back | — |
