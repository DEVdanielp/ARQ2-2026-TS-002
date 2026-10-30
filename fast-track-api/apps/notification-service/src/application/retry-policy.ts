/**
 * RetryPolicy: what happens after a failed send (spec 5.4 NotificationRetry,
 * ADR-012, ADR-017).
 *
 *   first send fails  -> RETRYING, retry 1 scheduled in 1 min
 *   retry 1 fails     -> RETRYING, retry 2 scheduled in 5 min
 *   retry 2 fails     -> RETRYING, retry 3 scheduled in 15 min
 *   retry 3 fails     -> DEAD_LETTERED, message to notifications.retry.dlq
 *
 * "Scheduling" means writing a NotificationRetry to the outbox with
 * `publish_after`; the relay publishes it when it is due, so no consumer ever
 * waits (ADR-017). The waits come from NotificationSettings so they can be
 * shortened for local testing.
 */
import { Injectable } from '@nestjs/common';
import { createEnvelope, type EventEnvelope } from '@libs/events';
import type { NotificationKey, NotificationRetryPayload } from './ports.js';
import { NotificationLogRepository, NotificationSettings } from './ports.js';

/** Context of the failed attempt. */
export interface FailedAttempt {
  logId: string;
  key: NotificationKey;
  customerId: string;
  /** 0 for the first send, otherwise the retry number that just failed. */
  retryNumber: number;
  error: string;
  correlationId: string;
}

export type FailureOutcome = 'RETRYING' | 'DEAD_LETTERED';

@Injectable()
export class RetryPolicy {
  constructor(
    private readonly log: NotificationLogRepository,
    private readonly settings: NotificationSettings,
  ) {}

  /** Number of retries after the first send (3 in the spec). */
  get maxRetries(): number {
    return this.settings.retryBackoffSeconds.length;
  }

  /** Records the failure and either schedules the next retry or dead-letters. */
  async handleFailure(failed: FailedAttempt, now: Date = new Date()): Promise<FailureOutcome> {
    // Sends made so far: the first send plus the retries already tried.
    const attempts = failed.retryNumber + 1;

    if (failed.retryNumber < this.maxRetries) {
      const nextRetry = failed.retryNumber + 1;
      const notBefore = new Date(now.getTime() + this.settings.retryBackoffSeconds[failed.retryNumber] * 1000);
      const envelope = this.retryEnvelope(failed, nextRetry, notBefore);
      await this.log.markRetrying(failed.logId, attempts, failed.error, envelope, notBefore);
      return 'RETRYING';
    }

    // Out of retries: keep the last retry's data so the DLQ message explains itself.
    const envelope = this.retryEnvelope(failed, failed.retryNumber, now);
    await this.log.markDeadLettered(failed.logId, attempts, failed.error, envelope);
    return 'DEAD_LETTERED';
  }

  private retryEnvelope(
    failed: FailedAttempt,
    attempt: number,
    notBefore: Date,
  ): EventEnvelope<NotificationRetryPayload> {
    return createEnvelope<NotificationRetryPayload>({
      eventType: 'NotificationRetry',
      schemaVersion: 1,
      producer: 'notification-service',
      correlationId: failed.correlationId,
      aggregateId: failed.key.orderId,
      aggregateVersion: null,
      payload: {
        orderId: failed.key.orderId,
        customerId: failed.customerId,
        type: failed.key.type,
        channel: failed.key.channel,
        attempt,
        notBefore: notBefore.toISOString(),
        lastError: failed.error,
      },
    });
  }
}
