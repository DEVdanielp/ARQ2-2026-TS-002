# GPS Tracking Worker (F2, F5)

Processes each driver's GPS points strictly in sequence order, stores the
append-only history, keeps the last known location, publishes it for the
driver's orders on the way and detects proximity (NEARBY). Owns `tracking-db`.
A pure Kafka consumer: **no HTTP API**. Contract: `docs/spec.md` §5.4, F2, F5;
decisions: ADR-001, ADR-009, ADR-011, ADR-013, ADR-015, ADR-018.

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
    out/eta/           Maps/ETA provider over HTTP, or distance only
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
| `ETA_PROVIDER_URL` | Maps/ETA provider; empty = distance only. Contract in ADR-018 |
| `ETA_LOOKUP_RADIUS_METERS`, `ETA_MIN_INTERVAL_SECONDS`, `ETA_TIMEOUT_MS` | optional, default 3000, 60, 2000 |

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
| F5-S2 no second NEARBY | `tracking.spec.ts` › F5-S2 | F5-S1/S2 |
| Cross-topic order, compensations, dedup | `tracking.spec.ts` › Monitored orders | order replication |
| Rollback on failure | `tracking.spec.ts` › rolls everything back | — |
