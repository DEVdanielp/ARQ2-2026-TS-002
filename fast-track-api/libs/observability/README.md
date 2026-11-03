# @libs/observability

Metrics, traces and logs for every FastTrack service, wired to the stack in
`docker-compose.yml`: **Prometheus** (metrics), **Tempo** (traces), **Loki**
(logs, shipped by Promtail) and **Grafana** (<http://localhost:3001>, `admin` /
`admin`), which has the three as data sources.

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
Tempo). The **trace id is the correlation id** without dashes: an HTTP request
and every event it causes, in every service, share one trace, even across the
outbox. Spans: one `SERVER` span per HTTP request, one `CONSUMER` span per
consumed message (retries and DLQ included) and one `PRODUCER` span per write
to Kafka (a child of the message being handled). Find a flow in Grafana →
Explore → Tempo → *TraceQL*, by pasting the correlation id without dashes.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset = no tracing | OTLP/HTTP base URL (`http://tempo:4318`) |
| `LOG_FORMAT` | text | `json` for Loki |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `verbose` |

## 4. Limits

- Only our own boundaries are traced (HTTP in, Kafka in/out). Database,
  Redis and provider calls (SMTP, FCM, ETA) show up as time inside those
  spans, not as spans of their own.
- Each unit of work is a root span of the correlation trace, so a trace has
  several roots (one per service step); Tempo shows them together.
- The last few seconds of spans may be lost when a container stops (they are
  exported in batches every 5 s).
