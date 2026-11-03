/**
 * Distributed tracing with OpenTelemetry, exported over OTLP to Tempo.
 *
 * The trace id IS the correlation id
 * ----------------------------------
 * Kong gives every request an `X-Correlation-Id` (a UUID) and every event
 * carries it as `correlationId` (spec §2). A UUID without dashes is a valid
 * 32-hex trace id, so a span that starts a unit of work (an HTTP request, a
 * consumed Kafka message) uses the correlation id as its trace id. Result:
 * every span of one business flow, in every service, lands in the same trace,
 * even across the outbox, where no trace context could travel (the relay
 * publishes later, from another transaction). Searching Tempo by the
 * correlation id (dashes removed) shows the whole flow.
 *
 * Inside a span, new spans are children of it (AsyncLocalStorage context), so
 * an event published while handling a message hangs below that message.
 *
 * Tracing is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (it is in
 * docker-compose.yml). Without it every call here is a cheap no-op.
 */
import { randomBytes } from 'node:crypto';
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  TracerProvider,
  type IdGenerator,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';

const TRACER_NAME = 'fasttrack';

/**
 * Trace id for the next root span. Set and cleared around one synchronous
 * `startSpan` call, so concurrent requests cannot see each other's value.
 */
let pendingTraceId: string | undefined;

class CorrelationIdGenerator implements IdGenerator {
  generateTraceId(): string {
    return pendingTraceId ?? randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }
}

let provider: TracerProvider | undefined;

export interface TracingOptions {
  env?: NodeJS.ProcessEnv;
  /** Tests pass a processor with an in-memory exporter instead of OTLP. */
  spanProcessor?: SpanProcessor;
}

/**
 * Starts exporting spans. Returns false (and does nothing) when tracing is not
 * configured or was already started.
 */
export function startTracing(serviceName: string, options: TracingOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (provider || (!options.spanProcessor && !env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
    return false;
  }
  // OTLPTraceExporter reads OTEL_EXPORTER_OTLP_ENDPOINT and appends /v1/traces.
  const spanProcessor = options.spanProcessor ?? new BatchSpanProcessor({ exporter: new OTLPTraceExporter() });
  provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    idGenerator: new CorrelationIdGenerator(),
    spanProcessors: [spanProcessor],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return true;
}

/** Flushes pending spans and turns tracing off (shutdown hooks, tests). */
export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
  trace.disable();
  context.disable();
}

/** `0b7d0c1e-3a55-...` → `0b7d0c1e3a55...`, or undefined if it is not a usable id. */
export function traceIdFromCorrelationId(correlationId: string | undefined): string | undefined {
  const hex = correlationId?.replace(/-/g, '').toLowerCase();
  return hex && /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex) ? hex : undefined;
}

export interface FastTrackSpanOptions extends SpanOptions {
  /** Used as the trace id when the span starts a unit of work. */
  correlationId?: string;
}

/**
 * Starts a span: a child of the active span if there is one, otherwise a root
 * span whose trace id is the correlation id. Returns the span and a context
 * holding it; run the work with `context.with(ctx, ...)` and end the span.
 */
export function startSpan(name: string, options: FastTrackSpanOptions = {}): { span: Span; ctx: Context } {
  const { correlationId, ...spanOptions } = options;
  const tracer = trace.getTracer(TRACER_NAME);
  const active = context.active();
  let span: Span;
  if (trace.getSpanContext(active)) {
    span = tracer.startSpan(name, spanOptions, active);
  } else {
    pendingTraceId = traceIdFromCorrelationId(correlationId);
    try {
      span = tracer.startSpan(name, spanOptions, ROOT_CONTEXT);
    } finally {
      pendingTraceId = undefined;
    }
  }
  return { span, ctx: trace.setSpan(active, span) };
}

/**
 * Runs `work` inside a new span (see `startSpan`) and ends it. A thrown error
 * is recorded on the span and rethrown.
 */
export async function runInSpan<T>(
  name: string,
  options: FastTrackSpanOptions,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const { span, ctx } = startSpan(name, options);
  return context.with(ctx, async () => {
    try {
      return await work(span);
    } catch (error) {
      markSpanFailed(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Records an error on a span and sets its status to ERROR. */
export function markSpanFailed(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Ids of the active span, for log lines; undefined when there is none. */
export function activeTraceIds(): { traceId: string; spanId: string } | undefined {
  const spanContext = trace.getSpanContext(context.active());
  return spanContext && trace.isSpanContextValid(spanContext)
    ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
    : undefined;
}
