import { createEnvelope } from '@libs/events';
import {
  MessageProcessor,
  RETRY_BACKOFF_MS,
  type ConsumedMessage,
  type EventHandler,
} from './message-processor.js';
import type { RawKafkaMessage } from './kafka-producer.service.js';

const FIXED_NOW = new Date('2026-10-18T15:20:07.000Z');

const envelope = createEnvelope({
  eventType: 'GpsBatchReceived',
  schemaVersion: 1,
  producer: 'gps-ingestion-api',
  correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
  aggregateId: 'driver-1',
  payload: { points: [] },
});

function message(value: string | null = JSON.stringify(envelope)): ConsumedMessage {
  return {
    topic: 'gps.batches',
    partition: 3,
    offset: '41',
    key: Buffer.from('driver-1'),
    value: value === null ? null : Buffer.from(value),
    headers: { eventType: Buffer.from('GpsBatchReceived'), correlationId: Buffer.from(envelope.correlationId) },
  };
}

/** Builds a processor with fakes: no real Kafka and no real waiting. */
function setup(handler: EventHandler) {
  const sleeps: number[] = [];
  const dlq: Array<{ topic: string; message: RawKafkaMessage }> = [];
  const sendToDlq = vi.fn(async (topic: string, msg: RawKafkaMessage) => {
    dlq.push({ topic, message: msg });
  });
  const processor = new MessageProcessor({
    groupId: 'gps-tracking-worker',
    handler,
    sendToDlq,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => FIXED_NOW,
  });
  return { processor, sleeps, dlq, sendToDlq };
}

/** A handler that fails `failures` times, then succeeds. */
function failingTimes(failures: number) {
  let calls = 0;
  return vi.fn<EventHandler>(async () => {
    calls++;
    if (calls <= failures) throw new Error(`boom #${calls}`);
  });
}

describe('MessageProcessor', () => {
  it('uses the backoff schedule of spec 5.2', () => {
    expect(RETRY_BACKOFF_MS).toEqual([200, 1000, 5000]);
  });

  it('succeeds at the first attempt without waiting or using the DLQ', async () => {
    const handler = failingTimes(0);
    const { processor, sleeps, sendToDlq } = setup(handler);

    const outcome = await processor.process(message());

    expect(outcome).toEqual({ status: 'processed', attempts: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(envelope, expect.objectContaining({ key: 'driver-1', offset: '41' }));
    expect(sleeps).toEqual([]);
    expect(sendToDlq).not.toHaveBeenCalled();
  });

  it('succeeds at the third attempt after waiting 200 ms and 1 s', async () => {
    const handler = failingTimes(2);
    const { processor, sleeps, sendToDlq } = setup(handler);

    const outcome = await processor.process(message());

    expect(outcome).toEqual({ status: 'processed', attempts: 3 });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 1000]);
    expect(sendToDlq).not.toHaveBeenCalled();
  });

  it('sends the original message to the DLQ after the first attempt and 3 retries fail', async () => {
    const handler = failingTimes(Infinity);
    const { processor, sleeps, dlq } = setup(handler);
    const original = message();

    const outcome = await processor.process(original);

    expect(outcome).toEqual({
      status: 'dead-lettered',
      reason: 'handler-failed',
      attempts: 4,
      error: 'Error: boom #4',
    });
    expect(handler).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([200, 1000, 5000]);

    expect(dlq).toHaveLength(1);
    expect(dlq[0].topic).toBe('gps.batches.dlq');
    // Same key and value bytes as the original message.
    expect(dlq[0].message.key).toEqual(original.key);
    expect(dlq[0].message.value).toEqual(original.value);
    // Original headers kept, failure headers added.
    expect(dlq[0].message.headers).toEqual({
      ...original.headers,
      'dlq-reason': 'handler-failed',
      'dlq-error': 'Error: boom #4',
      'dlq-attempts': '4',
      'dlq-source-topic': 'gps.batches',
      'dlq-source-partition': '3',
      'dlq-source-offset': '41',
      'dlq-consumer-group': 'gps-tracking-worker',
      'dlq-failed-at': FIXED_NOW.toISOString(),
    });
  });

  it('sends invalid JSON straight to the DLQ without calling the handler or retrying', async () => {
    const handler = failingTimes(0);
    const { processor, sleeps, dlq } = setup(handler);

    const outcome = await processor.process(message('{not json'));

    expect(outcome).toMatchObject({ status: 'dead-lettered', reason: 'invalid-message', attempts: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
    expect(dlq).toHaveLength(1);
    expect(dlq[0].message.value).toEqual(Buffer.from('{not json'));
    expect(dlq[0].message.headers).toMatchObject({ 'dlq-reason': 'invalid-message', 'dlq-attempts': '0' });
  });

  it('sends valid JSON that is not an envelope straight to the DLQ', async () => {
    const handler = failingTimes(0);
    const { processor, dlq } = setup(handler);

    const outcome = await processor.process(message(JSON.stringify({ hello: 'world' })));

    expect(outcome).toMatchObject({ status: 'dead-lettered', reason: 'invalid-message' });
    expect(handler).not.toHaveBeenCalled();
    expect(dlq).toHaveLength(1);
  });

  it('throws (so the offset is not committed) when the DLQ write fails', async () => {
    const { processor, sendToDlq } = setup(failingTimes(0));
    sendToDlq.mockRejectedValueOnce(new Error('DLQ unavailable'));

    await expect(processor.process(message(null))).rejects.toThrow('DLQ unavailable');
  });
});
