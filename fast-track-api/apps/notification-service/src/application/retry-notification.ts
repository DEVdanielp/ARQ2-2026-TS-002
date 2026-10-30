/**
 * RetryNotification: the `RetryConsumer` logic (spec 5.4 NotificationRetry,
 * F5-S4).
 *
 * The message arrives when it is due (the outbox held it until `notBefore`,
 * ADR-017), so it retries immediately. It retries only the channel that
 * failed, with the customer's CURRENT contact data and devices.
 *
 * Idempotency: a retry is processed only if the log row is RETRYING and its
 * `attempts` equals the retry number (before retry n there were n sends). A
 * duplicate of an old retry message therefore does nothing, and a row that was
 * SENT or DEAD_LETTERED meanwhile is left alone.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@libs/events';
import { ChannelDelivery, describeError, RecipientDirectory } from './delivery.js';
import { renderCustomerMessage } from './messages.js';
import { NotificationLogRepository, type NotificationRetryPayload } from './ports.js';
import { RetryPolicy } from './retry-policy.js';

export type RetryResult = 'SENT' | 'RETRYING' | 'DEAD_LETTERED' | 'IGNORED';

@Injectable()
export class RetryNotification {
  private readonly logger = new Logger(RetryNotification.name);

  constructor(
    private readonly log: NotificationLogRepository,
    private readonly directory: RecipientDirectory,
    private readonly delivery: ChannelDelivery,
    private readonly retries: RetryPolicy,
  ) {}

  async execute(envelope: EventEnvelope<NotificationRetryPayload>): Promise<RetryResult> {
    const retry = envelope.payload;
    const key = { orderId: retry.orderId, type: retry.type, channel: retry.channel };

    const entry = await this.log.find(key);
    if (!entry || entry.status !== 'RETRYING' || entry.attempts !== retry.attempt) {
      this.logger.log({ msg: 'Retry ignored (already handled)', ...key, attempt: retry.attempt, status: entry?.status });
      return 'IGNORED';
    }

    const recipient = await this.directory.load(retry.customerId);
    const message = renderCustomerMessage(retry.type, { orderId: retry.orderId, customerName: recipient.name });

    try {
      await this.delivery.deliver(retry.channel, recipient, message);
      await this.log.markSent(entry.id, retry.attempt + 1);
      this.logger.log({ msg: 'Notification sent on retry', ...key, attempt: retry.attempt, correlationId: envelope.correlationId });
      return 'SENT';
    } catch (error) {
      const outcome = await this.retries.handleFailure({
        logId: entry.id,
        key,
        customerId: retry.customerId,
        retryNumber: retry.attempt,
        error: describeError(error),
        correlationId: envelope.correlationId,
      });
      this.logger.warn({ msg: 'Retry failed', ...key, attempt: retry.attempt, outcome, error: describeError(error), correlationId: envelope.correlationId });
      return outcome;
    }
  }
}
