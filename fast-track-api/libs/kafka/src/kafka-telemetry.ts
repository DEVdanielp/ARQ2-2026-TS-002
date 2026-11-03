/**
 * Metrics and spans around every Kafka message (libs/observability).
 *
 * The span's trace id is the message's `correlationId` header, so a consumed
 * event joins the trace of the request that caused it, in whatever service
 * that request entered (see libs/observability/src/tracing.ts). Events
 * published while handling a message are child spans of it.
 */
import { SpanKind } from '@opentelemetry/api';
import {
  kafkaHandlerRetries,
  kafkaMessageProcessingDuration,
  kafkaMessagesConsumed,
  kafkaMessagesPublished,
  markSpanFailed,
  runInSpan,
} from '@libs/observability';
import { headerAsString, KafkaHeaders, type KafkaHeaderMap } from './kafka-headers.js';
import type { ProcessOutcome } from './message-processor.js';

export interface ConsumedMessageInfo {
  topic: string;
  partition: number;
  offset: string;
  groupId: string;
  headers: KafkaHeaderMap;
}

/** Runs the processing of one consumed message inside a CONSUMER span and records its outcome. */
export async function observeConsumed(
  info: ConsumedMessageInfo,
  process: () => Promise<ProcessOutcome>,
): Promise<ProcessOutcome> {
  const startedAt = performance.now();
  const eventType = headerAsString(info.headers, KafkaHeaders.EVENT_TYPE);
  const outcome = await runInSpan(
    `${info.topic} process`,
    {
      kind: SpanKind.CONSUMER,
      correlationId: headerAsString(info.headers, KafkaHeaders.CORRELATION_ID),
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'process',
        'messaging.destination.name': info.topic,
        'messaging.destination.partition.id': String(info.partition),
        'messaging.kafka.offset': info.offset,
        'messaging.consumer.group.name': info.groupId,
        ...(eventType ? { 'fasttrack.event_type': eventType } : {}),
      },
    },
    async (span) => {
      const result = await process();
      span.setAttribute('fasttrack.attempts', result.attempts);
      if (result.status === 'dead-lettered') {
        markSpanFailed(span, new Error(`Sent to DLQ (${result.reason}): ${result.error}`));
      }
      return result;
    },
  );

  const label = outcome.status === 'processed' ? 'processed' : 'dead_lettered';
  kafkaMessagesConsumed.inc({ topic: info.topic, outcome: label });
  kafkaMessageProcessingDuration.observe({ topic: info.topic, outcome: label }, (performance.now() - startedAt) / 1000);
  if (outcome.attempts > 1) {
    kafkaHandlerRetries.inc({ topic: info.topic }, outcome.attempts - 1);
  }
  return outcome;
}

/** Runs one write to Kafka inside a PRODUCER span and counts it. */
export async function observePublish<T>(
  topic: string,
  headers: KafkaHeaderMap | undefined,
  send: () => Promise<T>,
): Promise<T> {
  const eventType = headerAsString(headers, KafkaHeaders.EVENT_TYPE);
  return runInSpan(
    `${topic} publish`,
    {
      kind: SpanKind.PRODUCER,
      correlationId: headerAsString(headers, KafkaHeaders.CORRELATION_ID),
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'send',
        'messaging.destination.name': topic,
        ...(eventType ? { 'fasttrack.event_type': eventType } : {}),
      },
    },
    async () => {
      try {
        const result = await send();
        kafkaMessagesPublished.inc({ topic, result: 'ok' });
        return result;
      } catch (error) {
        kafkaMessagesPublished.inc({ topic, result: 'error' });
        throw error;
      }
    },
  );
}
