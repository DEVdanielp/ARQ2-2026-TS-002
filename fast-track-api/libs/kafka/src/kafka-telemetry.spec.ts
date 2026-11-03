import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import {
  kafkaHandlerRetries,
  kafkaMessagesConsumed,
  kafkaMessagesPublished,
  startTracing,
  stopTracing,
} from '@libs/observability';
import { KafkaHeaders } from './kafka-headers.js';
import { observeConsumed, observePublish } from './kafka-telemetry.js';

const CORRELATION_ID = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';
const TRACE_ID = '0b7d0c1e3a554b8e9d2b5f0c2a9a7e11';

async function counterValue(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: object }> }> },
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await metric.get();
  const entry = values.find((v) => Object.entries(labels).every(([k, val]) => (v.labels as Record<string, string>)[k] === val));
  return entry?.value ?? 0;
}

describe('Kafka telemetry', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    startTracing('test-service', { spanProcessor: new SimpleSpanProcessor({ exporter }) });
  });

  afterEach(async () => {
    await stopTracing();
  });

  const info = (topic: string) => ({
    topic,
    partition: 3,
    offset: '42',
    groupId: 'test-service',
    headers: { [KafkaHeaders.CORRELATION_ID]: CORRELATION_ID, [KafkaHeaders.EVENT_TYPE]: 'OrderCreated' },
  });

  it('counts a processed message and its retries, inside a CONSUMER span of the correlation trace', async () => {
    const before = await counterValue(kafkaMessagesConsumed, { topic: 'telemetry.ok', outcome: 'processed' });

    await observeConsumed(info('telemetry.ok'), async () => ({ status: 'processed', attempts: 3 }));

    expect(await counterValue(kafkaMessagesConsumed, { topic: 'telemetry.ok', outcome: 'processed' })).toBe(before + 1);
    expect(await counterValue(kafkaHandlerRetries, { topic: 'telemetry.ok' })).toBe(2);
    const [span] = exporter.getFinishedSpans();
    expect(span).toMatchObject({ name: 'telemetry.ok process', kind: SpanKind.CONSUMER });
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.attributes).toMatchObject({ 'messaging.destination.name': 'telemetry.ok', 'fasttrack.event_type': 'OrderCreated' });
  });

  it('counts a dead-lettered message and marks its span as failed', async () => {
    await observeConsumed(info('telemetry.dlq'), async () => ({
      status: 'dead-lettered',
      reason: 'handler-failed',
      attempts: 4,
      error: 'Error: database down',
    }));

    expect(await counterValue(kafkaMessagesConsumed, { topic: 'telemetry.dlq', outcome: 'dead_lettered' })).toBe(1);
    expect(exporter.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('publishes as a child span of the message being handled', async () => {
    await observeConsumed(info('telemetry.parent'), async () => {
      await observePublish('telemetry.out', { [KafkaHeaders.CORRELATION_ID]: CORRELATION_ID }, async () => ({ partition: 0 }));
      return { status: 'processed', attempts: 1 };
    });

    const [publish, consume] = exporter.getFinishedSpans();
    expect(publish).toMatchObject({ name: 'telemetry.out publish', kind: SpanKind.PRODUCER });
    expect(publish.parentSpanContext?.spanId).toBe(consume.spanContext().spanId);
    expect(await counterValue(kafkaMessagesPublished, { topic: 'telemetry.out', result: 'ok' })).toBe(1);
  });

  it('counts a failed publish and rethrows', async () => {
    await expect(
      observePublish('telemetry.fail', undefined, async () => {
        throw new Error('broker down');
      }),
    ).rejects.toThrow('broker down');

    expect(await counterValue(kafkaMessagesPublished, { topic: 'telemetry.fail', result: 'error' })).toBe(1);
  });
});
