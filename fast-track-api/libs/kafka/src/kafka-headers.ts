/**
 * Names of the Kafka message headers used by FastTrack, plus a small helper.
 *
 * Headers are key/value metadata attached to a Kafka message, next to the key
 * and the value. Tools (Kafka UI, consumers, tracing) can read them without
 * parsing the JSON value. Spec 5.1 requires `eventType` and `correlationId` on
 * every message; the `dlq-*` headers are added when a message is moved to a
 * dead-letter queue (ADR-012).
 */

export const KafkaHeaders = {
  /** Copy of `envelope.eventType` (spec 5.1). */
  EVENT_TYPE: 'eventType',
  /** Copy of `envelope.correlationId` (spec 5.1). */
  CORRELATION_ID: 'correlationId',

  /** Why the message was dead-lettered: `invalid-message` or `handler-failed`. */
  DLQ_REASON: 'dlq-reason',
  /** Error message of the last failure (truncated). */
  DLQ_ERROR: 'dlq-error',
  /** How many times the handler was called before giving up (0 for invalid messages). */
  DLQ_ATTEMPTS: 'dlq-attempts',
  /** Topic the message was consumed from. */
  DLQ_SOURCE_TOPIC: 'dlq-source-topic',
  /** Partition the message was consumed from. */
  DLQ_SOURCE_PARTITION: 'dlq-source-partition',
  /** Offset of the message in its source partition. */
  DLQ_SOURCE_OFFSET: 'dlq-source-offset',
  /** Consumer group that failed to process it. */
  DLQ_CONSUMER_GROUP: 'dlq-consumer-group',
  /** When it was dead-lettered, ISO-8601 UTC. */
  DLQ_FAILED_AT: 'dlq-failed-at',
} as const;

/**
 * Kafka header map. Values arrive from the broker as Buffers (or arrays of
 * Buffers when a header is repeated); we may send strings.
 */
export type KafkaHeaderMap = Record<string, Buffer | string | (Buffer | string)[] | undefined>;

/**
 * Reads a header as a string (first value if repeated), or `undefined`.
 * Useful for logging headers of consumed messages.
 */
export function headerAsString(headers: KafkaHeaderMap | undefined, name: string): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}
