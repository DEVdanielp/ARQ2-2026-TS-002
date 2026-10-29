/**
 * MessageProcessor: what happens to ONE consumed Kafka message.
 *
 * Why it exists
 * -------------
 * This is the heart of the consumer's reliability rules, kept free of any
 * Kafka client code so it can be unit-tested with plain fakes:
 *
 *   1. Parse the value into an EventEnvelope. If it is not valid JSON / not an
 *      envelope, send it straight to the DLQ: retrying cannot fix bad bytes.
 *   2. Call the service's handler.
 *   3. If the handler throws, retry it in-process up to 3 times, waiting
 *      200 ms, 1 s and 5 s between attempts (spec 5.2). Most failures are
 *      transient (a database restart, a network blip) and a short wait fixes
 *      them. The waits grow ("exponential backoff") so we do not hammer a
 *      dependency that is already struggling.
 *   4. If it still fails (1 initial attempt + 3 retries = 4 attempts), copy the
 *      original message to `<topic>.dlq` with extra headers describing the
 *      failure, and report it as done, so the consumer commits the offset and
 *      moves on (ADR-012).
 *
 * Why the DLQ instead of retrying forever
 * ---------------------------------------
 * A partition is processed strictly one message at a time to keep per-key
 * order. A message that always fails (a "poison pill") would block every
 * message behind it in that partition, i.e. every other driver or order that
 * hashes to it. Parking it in the DLQ unblocks the partition and keeps the
 * message visible and replayable for a human (ADR-012).
 *
 * What if writing to the DLQ fails?
 * ---------------------------------
 * Then `process()` throws. The caller must NOT commit the offset, so Kafka
 * delivers the same message again: we never lose a message just because the
 * DLQ was unavailable (at-least-once, spec 5.2).
 */
import { dlqTopic, InvalidEnvelopeError, parseEnvelope, type EventEnvelope } from '@libs/events';
import { KafkaHeaders, type KafkaHeaderMap } from './kafka-headers.js';
import type { RawKafkaMessage } from './kafka-producer.service.js';

/** Waits between handler attempts (spec 5.2): 3 retries after the first attempt. */
export const RETRY_BACKOFF_MS: readonly number[] = [200, 1_000, 5_000];

/** Longest error text copied into the `dlq-error` header, to keep headers small. */
const MAX_ERROR_HEADER_LENGTH = 1_000;

/** A consumed message, independent of the Kafka client library. */
export interface ConsumedMessage {
  topic: string;
  partition: number;
  /** Offset as a decimal string (Kafka offsets are 64-bit). */
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: KafkaHeaderMap;
}

/** Metadata given to the handler together with the envelope. */
export interface MessageContext {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  headers: KafkaHeaderMap;
}

/**
 * Business logic of a consumer. Must be idempotent: the same envelope can
 * arrive more than once (ADR-009). Throw to signal a failure; it is retried.
 */
export type EventHandler<TPayload = unknown> = (
  envelope: EventEnvelope<TPayload>,
  context: MessageContext,
) => Promise<void>;

/** Why a message was sent to the DLQ (value of the `dlq-reason` header). */
export type DlqReason = 'invalid-message' | 'handler-failed';

/** Result of processing a message. Either way, the offset can be committed. */
export type ProcessOutcome =
  | { status: 'processed'; attempts: number }
  | { status: 'dead-lettered'; reason: DlqReason; attempts: number; error: string };

/** Minimal logger interface (Nest's `Logger` satisfies it). */
export interface ProcessorLogger {
  log(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

/** Everything the processor needs from the outside world, injected for testability. */
export interface MessageProcessorDeps<TPayload = unknown> {
  /** Consumer group, recorded in the DLQ headers. */
  groupId: string;
  /** The service's business logic. */
  handler: EventHandler<TPayload>;
  /** Writes a message to a topic untouched (`KafkaProducerService.send`). */
  sendToDlq: (topic: string, message: RawKafkaMessage) => Promise<unknown>;
  /** Waits between retries; replaced by a fake in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff schedule; defaults to {@link RETRY_BACKOFF_MS}. */
  backoffMs?: readonly number[];
  logger?: ProcessorLogger;
  /** Clock, for the `dlq-failed-at` header; replaced in tests. */
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const silentLogger: ProcessorLogger = { log: () => {}, warn: () => {}, error: () => {} };

export class MessageProcessor<TPayload = unknown> {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: readonly number[];
  private readonly logger: ProcessorLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: MessageProcessorDeps<TPayload>) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.backoffMs = deps.backoffMs ?? RETRY_BACKOFF_MS;
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Processes one message: parse, handle with retries, or dead-letter.
   *
   * @returns how the message ended; in both cases it is safe to commit.
   * @throws only if the message had to go to the DLQ and writing there failed.
   *   In that case the caller must not commit, so the message is redelivered.
   */
  async process(message: ConsumedMessage): Promise<ProcessOutcome> {
    const key = message.key?.toString('utf8') ?? null;
    const base = { topic: message.topic, partition: message.partition, offset: message.offset, key };

    // 1. Deserialize. A bad message is not retried: it would fail every time.
    let envelope: EventEnvelope<TPayload>;
    try {
      envelope = parseEnvelope<TPayload>(message.value?.toString('utf8') ?? null);
    } catch (error) {
      if (error instanceof InvalidEnvelopeError) {
        return this.deadLetter(message, 'invalid-message', 0, error);
      }
      throw error;
    }

    const logContext = {
      ...base,
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
    };
    const context: MessageContext = { ...base, headers: message.headers };
    const maxAttempts = this.backoffMs.length + 1;

    // 2-3. Call the handler; on failure wait and retry, up to maxAttempts.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.handler(envelope, context);
        this.logger.log({ msg: 'Event processed', ...logContext, attempts: attempt });
        return { status: 'processed', attempts: attempt };
      } catch (error) {
        if (attempt >= maxAttempts) {
          // 4. Out of retries: park it in the DLQ so the partition can move on.
          return this.deadLetter(message, 'handler-failed', attempt, error, logContext);
        }
        const delay = this.backoffMs[attempt - 1];
        this.logger.warn({
          msg: `Handler failed, retrying in ${delay} ms`,
          ...logContext,
          attempt,
          maxAttempts,
          error: errorMessage(error),
        });
        await this.sleep(delay);
      }
    }
  }

  /**
   * Copies the ORIGINAL message (same key, value and headers) to `<topic>.dlq`,
   * adding `dlq-*` headers that explain what went wrong and where it came from.
   * Keeping the original bytes means the message can be replayed to the source
   * topic as-is once the bug is fixed; keeping the key keeps DLQ messages of the
   * same driver/order together and in order.
   */
  private async deadLetter(
    message: ConsumedMessage,
    reason: DlqReason,
    attempts: number,
    error: unknown,
    logContext: Record<string, unknown> = {},
  ): Promise<ProcessOutcome> {
    const text = errorMessage(error);
    const target = dlqTopic(message.topic);

    await this.deps.sendToDlq(target, {
      key: message.key,
      value: message.value,
      headers: {
        ...message.headers,
        [KafkaHeaders.DLQ_REASON]: reason,
        [KafkaHeaders.DLQ_ERROR]: text.slice(0, MAX_ERROR_HEADER_LENGTH),
        [KafkaHeaders.DLQ_ATTEMPTS]: String(attempts),
        [KafkaHeaders.DLQ_SOURCE_TOPIC]: message.topic,
        [KafkaHeaders.DLQ_SOURCE_PARTITION]: String(message.partition),
        [KafkaHeaders.DLQ_SOURCE_OFFSET]: message.offset,
        [KafkaHeaders.DLQ_CONSUMER_GROUP]: this.deps.groupId,
        [KafkaHeaders.DLQ_FAILED_AT]: this.now().toISOString(),
      },
    });

    this.logger.error({
      msg: `Message sent to ${target}`,
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
      key: message.key?.toString('utf8') ?? null,
      ...logContext,
      reason,
      attempts,
      error: text,
    });
    return { status: 'dead-lettered', reason, attempts, error: text };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
