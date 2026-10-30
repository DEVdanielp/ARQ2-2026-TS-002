# fast-track-api

NestJS monorepo with the six FastTrack microservices and their shared
libraries. The contract is [`docs/spec.md`](../docs/spec.md); decisions are in
[`docs/adrs`](../docs/adrs).

## Layout

| Path | What |
| --- | --- |
| `apps/gps-ingestion-api` | F2: receives GPS batches, publishes `GpsBatchReceived` ([README](apps/gps-ingestion-api/README.md)) |
| `apps/gps-tracking-worker` | F2/F5: processes GPS in order, detects NEARBY ([README](apps/gps-tracking-worker/README.md)) |
| `apps/orders-service` | F4: order state machine |
| `apps/profiles-service` | F1: profiles and driver assignment |
| `apps/tracking-query-service` | F3: read model in Redis, REST + SSE |
| `apps/notification-service` | F5: push/email notifications ([README](apps/notification-service/README.md)) |
| `libs/events` | `EventEnvelope`, `createEnvelope`, topic names (`Topics`, `dlqTopic`), GPS event payloads |
| `libs/kafka` | producer/consumer with retries and DLQ ([README](libs/kafka/README.md)) |
| `libs/auth` | caller identity and role checks ([README](libs/auth/README.md)) |
| `libs/http` | problem+json errors and request validation (spec §2) ([README](libs/http/README.md)) |
| `libs/outbox` | transactional outbox with delayed publication (ADR-005, ADR-017) ([README](libs/outbox/README.md)) |
| `libs/observability` | not implemented yet |

Each service follows a hexagonal structure (ADR-014): `domain/`,
`application/`, `adapters/in/*`, `adapters/out/*`.

## Everyday commands

```powershell
npm install                       # once
npm test                          # unit tests (vitest)
npm run test:e2e                  # integration tests (*.e2e-spec.ts); the GPS worker's need TEST_DATABASE_URL
npx tsc -p tsconfig.spec.json     # type-check the tests
npm run build                     # build every app and lib
npx nest build <app>              # build one app, e.g. notification-service
npm run openapi:notification-service   # regenerate docs/openapi/notification-service.json
npm run openapi:gps-ingestion-api      # regenerate docs/openapi/gps-ingestion-api.json
```

Relative imports must end in `.js` (`"module": "nodenext"`). Add dependencies
to **this** `package.json`: it is the one Docker builds from.

## Local environment

```powershell
docker compose up -d                              # infrastructure only
docker compose --profile apps up -d --build       # + the six services
docker compose --profile apps up -d --build notification-service   # rebuild one
```

Ports and URLs are listed at the top of `docker-compose.yml` (Kong
`localhost:8000`, Kafka UI `localhost:8085`, MailHog `localhost:8025`, ...).

**Swagger UI** (`http://localhost:8090`): REST documentation of every service,
read from `docs/openapi/*.json`. *Try it out* goes through Kong; use
**Authorize** with a Keycloak token. See `libs/http/README.md` to add a service.

**pgAdmin** (`http://localhost:5050`, login `admin@fasttrack.dev` / `admin`)
comes with every service database pre-registered. Open one and enter its
password once (`fasttrack` for the service users, `postgres` for the
superuser), ticking *Save password*. Inspect data with your service's own
user: objects created as `postgres` are not owned by the service.

To run one service on the host instead (faster feedback), start its
dependencies with Docker, then run the built file; each service documents its
variables in its own `.env.example`.

## Troubleshooting

**`password authentication failed for user "<service>_db"`**: the Postgres
volume was created before `deploy/postgres/init-databases.sh` worked, and
Postgres only runs init scripts on an empty volume. Run it once by hand:

```powershell
docker compose exec postgres bash /docker-entrypoint-initdb.d/01-init-databases.sh
```

(or `docker compose down -v` to reset all local data).

**A file in `adapters/out` is not tracked by git**: the root `.gitignore`
used to ignore every folder named `out`; it now ignores only `/out`.
