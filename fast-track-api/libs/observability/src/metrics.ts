/**
 * Prometheus metrics shared by every FastTrack service.
 *
 * Every metric lives in the default registry of `@prometheus-io/client`, which
 * is what `GET /metrics` serves (see http.ts and metrics-server.ts). Prometheus
 * scrapes each service on port 3000 (deploy/observability/prometheus.yml), and
 * `initMetrics()` adds a `service` label so the six services can be told apart
 * in Grafana.
 *
 * Label values must stay few: the HTTP route is the route *template*
 * (`/v1/tracking/:orderId`), never the real path, and topics are the fixed
 * names of spec §5.1.
 */
import { collectDefaultMetrics, Counter, Histogram, register, type Registry } from '@prometheus-io/client';

/** The registry `GET /metrics` serves. */
export const metricsRegistry: Registry = register;

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Every HTTP request, by route template and status (RED metrics). */
export const httpRequestDuration = new Histogram({
  name: 'http_server_request_duration_seconds',
  help: 'Duration of HTTP requests handled by the service',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: LATENCY_BUCKETS,
});

/** Every consumed Kafka message, by outcome: `processed` or `dead_lettered` (ADR-012). */
export const kafkaMessagesConsumed = new Counter({
  name: 'kafka_messages_consumed_total',
  help: 'Kafka messages consumed, by outcome',
  labelNames: ['topic', 'outcome'] as const,
});

/** Time from receiving a message to its final outcome, retries included. */
export const kafkaMessageProcessingDuration = new Histogram({
  name: 'kafka_message_processing_duration_seconds',
  help: 'Time to process a Kafka message, in-process retries included',
  labelNames: ['topic', 'outcome'] as const,
  buckets: LATENCY_BUCKETS,
});

/** In-process retries of a failing handler (200 ms, 1 s, 5 s; spec §5.2). */
export const kafkaHandlerRetries = new Counter({
  name: 'kafka_handler_retries_total',
  help: 'In-process retries of failed Kafka handlers',
  labelNames: ['topic'] as const,
});

/** Every message written to Kafka (direct, outbox relay or DLQ), by result. */
export const kafkaMessagesPublished = new Counter({
  name: 'kafka_messages_published_total',
  help: 'Kafka messages published, by result',
  labelNames: ['topic', 'result'] as const,
});

let initialized = false;

/**
 * Labels every metric with the service name and starts the Node.js runtime
 * metrics (CPU, memory, event loop lag, GC). Safe to call more than once.
 */
export function initMetrics(serviceName: string): void {
  if (initialized) return;
  metricsRegistry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: metricsRegistry });
  initialized = true;
}
