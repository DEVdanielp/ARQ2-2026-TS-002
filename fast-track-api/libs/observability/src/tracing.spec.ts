import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { activeTraceIds, runInSpan, startTracing, stopTracing, traceIdFromCorrelationId } from './tracing.js';

const CORRELATION_ID = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';
const TRACE_ID = '0b7d0c1e3a554b8e9d2b5f0c2a9a7e11';

describe('traceIdFromCorrelationId', () => {
  it('turns a UUID into a 32-hex trace id', () => {
    expect(traceIdFromCorrelationId(CORRELATION_ID)).toBe(TRACE_ID);
    expect(traceIdFromCorrelationId(CORRELATION_ID.toUpperCase())).toBe(TRACE_ID);
  });

  it('rejects anything that is not a usable trace id', () => {
    expect(traceIdFromCorrelationId(undefined)).toBeUndefined();
    expect(traceIdFromCorrelationId('not-a-uuid')).toBeUndefined();
    expect(traceIdFromCorrelationId('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('spans', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    expect(startTracing('test-service', { spanProcessor: new SimpleSpanProcessor({ exporter }) })).toBe(true);
  });

  afterEach(async () => {
    await stopTracing();
  });

  it('is off without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    await stopTracing();
    expect(startTracing('test-service', { env: {} })).toBe(false);
  });

  it('uses the correlation id as the trace id of a root span', async () => {
    await runInSpan('orders.events process', { kind: SpanKind.CONSUMER, correlationId: CORRELATION_ID }, async () => {});

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('orders.events process');
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('nests spans opened inside another one, whatever their correlation id', async () => {
    await runInSpan('parent', { correlationId: CORRELATION_ID }, async () => {
      expect(activeTraceIds()?.traceId).toBe(TRACE_ID);
      await runInSpan('child', { correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, async () => {});
    });

    const [child, parent] = exporter.getFinishedSpans();
    expect(child.spanContext().traceId).toBe(TRACE_ID);
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('starts a random trace when there is no valid correlation id', async () => {
    await runInSpan('a', {}, async () => {});
    await runInSpan('b', {}, async () => {});

    const [a, b] = exporter.getFinishedSpans();
    expect(a.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanContext().traceId).not.toBe(b.spanContext().traceId);
  });

  it('records a thrown error and rethrows it', async () => {
    await expect(
      runInSpan('failing', { correlationId: CORRELATION_ID }, async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');

    const [span] = exporter.getFinishedSpans();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'database down' });
    expect(span.events.map((event) => event.name)).toContain('exception');
  });

  it('has no active trace ids outside a span', () => {
    expect(activeTraceIds()).toBeUndefined();
  });
});
