/**
 * HTTP side of observability for the services that run a Nest HTTP app.
 *
 * `setupHttpObservability(app)` adds, before any route:
 * - `GET /metrics`: the Prometheus registry. It is outside `/v1`, so Kong
 *   (which only routes `/v1/...`) never exposes it; Prometheus scrapes it on
 *   the Docker network.
 * - a middleware that, for every other request, opens a SERVER span (trace id
 *   = `X-Correlation-Id`, see tracing.ts), observes
 *   `http_server_request_duration_seconds` and writes one access log line.
 *   The span is active while the request is handled, so events published by
 *   the handler and its log lines belong to the same trace.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { httpRequestDuration, metricsRegistry } from './metrics.js';
import { startSpan } from './tracing.js';

export const METRICS_PATH = '/metrics';

/** What the middleware reads from an Express request. */
interface ObservedRequest extends IncomingMessage {
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

type Next = (error?: unknown) => void;

/** Answers a scrape with every metric of the registry. */
export function serveMetrics(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET');
    response.end();
    return;
  }
  metricsRegistry.metrics().then(
    (body) => {
      response.setHeader('Content-Type', metricsRegistry.contentType);
      response.end(request.method === 'HEAD' ? undefined : body);
    },
    (error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    },
  );
}

/**
 * Route template (`/v1/tracking/:orderId`), or `unmatched` (keeps label values
 * few). Nest answers unknown paths from a catch-all route (`/v1*path`); that
 * counts as unmatched too.
 */
export function routeTemplate(request: ObservedRequest): string {
  const path = request.route?.path;
  return typeof path === 'string' && !path.includes('*') ? `${request.baseUrl ?? ''}${path}` : 'unmatched';
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function httpObservabilityMiddleware(logger = new Logger('HTTP')) {
  return (request: ObservedRequest, response: ServerResponse, next: Next): void => {
    const startedAt = process.hrtime.bigint();
    const method = request.method ?? 'GET';
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    const correlationId = header(request, 'x-correlation-id');
    const { span, ctx } = startSpan(`${method} ${path}`, {
      kind: SpanKind.SERVER,
      correlationId,
      attributes: { 'http.request.method': method, 'url.path': path },
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = routeTemplate(request);
      // 'close' without 'finish' = the client went away (e.g. an SSE stream closed).
      const status = response.writableFinished ? response.statusCode : 499;
      httpRequestDuration.observe({ method, route, status_code: String(status) }, seconds);

      span.updateName(`${method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      context.with(ctx, () =>
        logger.log({
          msg: 'HTTP request',
          method,
          route,
          path,
          status,
          durationMs: Math.round(seconds * 1000),
          correlationId,
        }),
      );
      span.end();
    };
    response.once('finish', finish);
    response.once('close', finish);

    context.with(ctx, () => next());
  };
}

/** Call in main.ts right after `NestFactory.create()`, before any route runs. */
export function setupHttpObservability(app: INestApplication): void {
  app.use(METRICS_PATH, serveMetrics);
  app.use(httpObservabilityMiddleware());
}
