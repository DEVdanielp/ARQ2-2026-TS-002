# GPS Ingestion API (F2)

Receives batches of 1–50 GPS points from the driver app, validates them and
publishes them to Kafka (`gps.batches`, key = driverId) as `GpsBatchReceived`.
Returns `202` as soon as Kafka confirms the write; it **never processes the
points** and has **no database** (stateless). The points are processed by the
[GPS Tracking Worker](../gps-tracking-worker/README.md). Contract:
`docs/spec.md` §4.3, §5.4, F2; decisions: ADR-001, ADR-018.

## Structure (hexagonal, minimal on purpose: ADR-014)

```
src/
  application/
    ports.ts               GpsBatchPublisher port + EventBusUnavailableError
    ingest-gps-batch.ts    the use case: batch id, envelope, publish
  adapters/
    in/http/               LocationsController + DTOs (validation and Swagger)
    out/kafka/             KafkaGpsBatchPublisher (key = driverId, 5 s timeout)
  config/environment.ts    environment validation
  http-setup.ts            /v1 prefix, 64 KB body limit, problem+json, validation
  openapi.ts               Swagger document
  gps-ingestion-api.module.ts
```

## How a request is handled

`POST /v1/drivers/me/locations` (Kong → service, role `DRIVER`):

1. Body larger than 64 KB → `413` (before parsing).
2. `AuthGuard` decodes the JWT (Kong verified it): no token `401`, not a
   `DRIVER` `403`. The driver is the token's `sub`; a `driverId` in the body is
   an unknown field → `400`.
3. `ValidationPipe` checks `PointBatchDto`: 1–50 points, `lat` ∈ [-90, 90],
   `lng` ∈ [-180, 180], `deviceTime` RFC 3339 with zone and a real date,
   `sequence` integer ≥ 0, optional `accuracyMeters`/`speedKmh` ≥ 0. Any error
   → `400` problem+json listing every field (`points.3.lat`); nothing is
   published (F2-S2).
4. `IngestGpsBatch` builds `GpsBatchReceived` (`batchId`, `receivedAt`, device
   times in UTC, `correlationId` from `X-Correlation-Id`) and publishes it with
   key = driverId (acks=all, idempotent producer, from `@libs/kafka`).
5. Kafka confirmed → `202 { batchId, accepted }` (F2-S1). Not confirmed within
   `GPS_PUBLISH_TIMEOUT_MS` → `503`; the app keeps the batch and retries.

**Duplicates and retries:** no `Idempotency-Key` here (the spec does not
define one for this endpoint). A retried batch gets a new `batchId`, but the
worker ignores every sequence it already stored, so retries never duplicate
history or move the location backward (ADR-009, ADR-018). After a `503` the
Kafka client may still deliver the buffered batch; the retry is then a
harmless duplicate.

**Rate limit** (`429`, 300 requests/minute per token) is enforced by Kong.

## API documentation (Swagger)

| Where | URL |
| --- | --- |
| Shared Swagger UI (Docker, whole team) | <http://localhost:8090> → *GPS Ingestion API* |
| Served by the service (host run) | <http://localhost:3010/v1/gps-ingestion/docs> (JSON: `.../docs-json`) |
| Versioned file | [`docs/openapi/gps-ingestion-api.json`](../../../docs/openapi/gps-ingestion-api.json) |

Kong only routes `POST /v1/drivers/me/locations` to this service, so the docs
route is reachable on a host run only. After changing the endpoint or a DTO,
regenerate the file (no Kafka needed) and commit it:

```powershell
npm run openapi:gps-ingestion-api
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `KAFKA_BROKERS` | read by `@libs/kafka` (defaults to `localhost:9092`) |
| `GPS_PUBLISH_TIMEOUT_MS` | optional, default `5000`: wait for Kafka before `503` |
| `SWAGGER_ENABLED` | optional, `false` turns off the Swagger UI |
| `PORT` / `port` | HTTP port (default 3000) |

## Run and try it

```powershell
cd fast-track-api
docker compose up -d kafka kafka-init keycloak
Copy-Item apps/gps-ingestion-api/.env.example apps/gps-ingestion-api/.env
npx nest build gps-ingestion-api
node dist/apps/gps-ingestion-api/main.js          # http://localhost:3010

$token = (Invoke-RestMethod -Method Post "http://localhost:8180/realms/fasttrack/protocol/openid-connect/token" -Body @{ grant_type='password'; client_id='fasttrack-dev'; username='driver1'; password='password' }).access_token
Invoke-RestMethod -Method Post http://localhost:3010/v1/drivers/me/locations -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body '{"points":[{"lat":6.2442,"lng":-75.5812,"deviceTime":"2026-10-18T15:20:01Z","sequence":1041}]}'
```

Through Kong (Docker): `docker compose --profile apps up -d --build gps-ingestion-api`
and call `http://localhost:8000/v1/drivers/me/locations`. The event appears in
Kafka UI (<http://localhost:8085>) → Topics → `gps.batches`.

## Tests and spec scenarios

`npm test` (from `fast-track-api/`). The HTTP adapter runs with supertest and
the production HTTP setup; Kafka is replaced by a fake publisher.

| Scenario | Test |
| --- | --- |
| F2-S1 publishes keyed by driver, `202` without processing | `locations.controller.spec.ts` › F2-S1; `kafka-gps-batch-publisher.spec.ts` |
| F2-S2 0 or > 50 points → `400`, nothing published | `locations.controller.spec.ts` › F2-S2 |
| Invalid coordinates/time/sequence, `driverId` in body, `413`, `401`/`403`, `503` | `locations.controller.spec.ts` |
