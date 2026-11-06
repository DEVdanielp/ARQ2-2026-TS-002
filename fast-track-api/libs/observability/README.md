# @libs/observability

Metrics, traces and logs for every FastTrack service, wired to the stack in
`docker-compose.yml`: **Prometheus** (metrics), **Jaeger** and **Tempo**
(traces), **Loki** (logs, shipped by Promtail) and **Grafana**
(<http://localhost:3001>, `admin` / `admin`), which has all of them as data
sources.

Traces go from every service to an **OpenTelemetry Collector**
(`otel-collector:4318`, `deploy/observability/otel-collector.yml`), which
forwards each span to Jaeger (UI <http://localhost:16686>) and to Tempo. The
services only know the collector, so a backend can be added or removed without
touching them.

## 1. Use it in `main.ts`

```ts
import { initObservability, setupHttpObservability } from '@libs/observability';

const { logger } = initObservability('notification-service'); // before NestFactory.create
const app = await NestFactory.create(NotificationServiceModule, { logger });
setupHttpObservability(app); // before any route runs
```

A service without an HTTP app (the GPS Tracking Worker) starts a small server
instead: `await startMetricsServer(process.env.PORT ?? 3000)` (`/metrics` and
`/health`).

Every service already does this. Kafka metrics and spans come for free from
`@libs/kafka`; nothing to add in handlers.

## 2. What you get

**Metrics** (`GET /metrics` on port 3000, outside `/v1`, so Kong never exposes
it). Every series carries `service`.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `http_server_request_duration_seconds` | `method`, `route`, `status_code` | every HTTP request; `route` is the template (`/v1/tracking/:orderId`) or `unmatched`; `499` = client went away |
| `kafka_messages_consumed_total` | `topic`, `outcome` | `processed` or `dead_lettered` |
| `kafka_message_processing_duration_seconds` | `topic`, `outcome` | retries included |
| `kafka_handler_retries_total` | `topic` | in-process retries (200 ms, 1 s, 5 s) |
| `kafka_messages_published_total` | `topic`, `result` | every write: direct, outbox relay and DLQ; `ok` / `error` |
| `process_*`, `nodejs_*` | | CPU, memory, event loop lag, GC |

Examples for Grafana → Explore → Prometheus:

```promql
sum by (service, route) (rate(http_server_request_duration_seconds_count{status_code=~"5.."}[5m]))
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{service="tracking-query-service"}[5m])))
sum by (topic) (increase(kafka_messages_consumed_total{outcome="dead_lettered"}[1h]))
```

**Traces** (only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; compose sets it to
the collector). The **trace id is the correlation id** without dashes: an HTTP request
and every event it causes, in every service, share one trace, even across the
outbox. Spans: one `SERVER` span per HTTP request, one `CONSUMER` span per
consumed message (retries and DLQ included) and one `PRODUCER` span per write
to Kafka (a child of the message being handled). Find a flow by pasting the
correlation id without dashes in the *Lookup by Trace ID* box of the Jaeger UI
(<http://localhost:16686>), or in Grafana → Explore → Tempo / Jaeger. In
Jaeger's *Search* tab, filter by service, operation (`POST /v1/orders`,
`orders.intents process`, ...) or tags such as `fasttrack.event_type=OrderCreated`,
`http.route=/v1/orders/:orderId/intents` or `error=true`.

**Client spans** (`client-spans.ts`): calls to dependencies show up as
`CLIENT` children of the request or message that made them:

| Dependency | How | Span name | Main attributes |
| --- | --- | --- | --- |
| PostgreSQL | `instrumentDataSource(dataSource)` in each `PersistenceModule` (`dataSourceFactory`) | `SELECT orders`, `INSERT outbox`, `SELECT pg_advisory_xact_lock`, `COMMIT orders_db`, grouped under `orders_db transaction` | `db.system.name`, `db.namespace`, `db.operation.name`, `db.collection.name`, `db.query.text` (with `$1` placeholders), `db.response.returned_rows` |
| Redis | `instrumentRedis(client)` in tracking-query-service's `RedisModule` | `HGETALL`, `EVALSHA`, `PUBLISH` | `db.query.summary` (command + key) |
| SMTP, FCM | `traceClient()` in the senders | `smtp send`, `fcm send`, `push send (log only)` | `server.address` |
| Maps/ETA | `tracedFetch()` in the ETA adapters | `openrouteservice POST`, `osrm GET`, `http GET` | `http.response.status_code`, `server.address`, `url.path` |

Rules: a client span is created **only inside an active span**, so the outbox
relay polling, schedulers and migrations stay untraced; **parameters and
values are never recorded** (SQL keeps its placeholders, Redis only the key,
SMTP/FCM no recipient or token); failures carry `error.type` (SQLSTATE such as
`40P01`, errno such as `ECONNREFUSED`). The instances are wrapped at startup
instead of using OpenTelemetry's auto-instrumentations, which hook module
loading and do not fit ESM services bundled by rspack.

**Logs**. With `LOG_FORMAT=json` (compose), one JSON object per line with
`level`, `context`, `message`, `service` and, inside a span, `traceId` /
`spanId`. Every HTTP request writes an access line (`msg: "HTTP request"`,
route, status, duration, `correlationId`). In Grafana → Explore → Loki, a
`traceId` opens the trace and a `correlationId` searches it in every service;
from a span in Tempo, *Logs for this span* goes back to Loki.

## 3. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | name passed to `initObservability` | `service` label, trace resource and log field |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset = no tracing | OTLP/HTTP base URL (`http://otel-collector:4318`) |
| `LOG_FORMAT` | text | `json` for Loki |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `verbose` |

## 4. Limits

- Database statements run by background loops (outbox relay, assignment
  retry scheduler, purge jobs) are not traced: they have no parent span.
- Redis connections created with `duplicate()` after instrumenting (the
  Pub/Sub subscriber) are not traced.
- Each unit of work is a root span of the correlation trace, so a trace has
  several roots (one per service step); Tempo shows them together.
- The last few seconds of spans may be lost when a container stops (they are
  exported in batches every 5 s).
- Jaeger keeps traces in memory: restarting its container clears them (Tempo
  keeps its copy).
- Kong does not emit spans; a trace starts at the first service.
