/**
 * NotifyCustomer: the core use case (F5-S1, S2, S3, S5).
 *
 * Triggered by OrderCreated (opt-in), OrderOnTheWay, DriverNearDestination,
 * OrderDelivered and OrderCancelled. Steps:
 *
 *   1. Find the customer of the order (local copy from OrderCreated).
 *   2. Apply the business filters (CREATED is opt-in; NEARBY is pointless
 *      once the order is delivered or cancelled).
 *   3. Choose channels from preferences and reachability (F5-S5).
 *   4. For each channel, CLAIM the notification_log row. Only a newly created
 *      (PENDING) row is sent: a redelivered event finds the row already SENT
 *      or RETRYING and does nothing. This is the idempotency rule of spec 5.2
 *      (UNIQUE(order, type, channel)) and gives F5-S2: one NEARBY per order.
 *   5. Send. Success -> SENT. Failure -> schedule a retry (RetryPolicy); the
 *      error is NOT rethrown, so a slow provider never blocks the partition
 *      (ADR-012, F5-S4).
 *
 * Known limit: if the process crashes after sending but before marking SENT,
 * the row stays PENDING and the redelivered event sends again. One duplicate
 * in a crash is the price of at-least-once delivery (ADR-009).
 */
import { Injectable, Logger } from '@nestjs/common';
import { selectChannels } from '../domain/channel-selection.js';
import { DEFAULT_PREFERENCES, type NotificationChannel, type NotificationType } from '../domain/notification.js';
import { ChannelDelivery, describeError, RecipientDirectory } from './delivery.js';
import { RecipientNotFoundError } from './errors.js';
import { renderCustomerMessage } from './messages.js';
import { NotificationLogRepository, OrderRecipientRepository, PreferencesRepository } from './ports.js';
import { RetryPolicy } from './retry-policy.js';

export interface NotifyCustomerCommand {
  orderId: string;
  type: NotificationType;
  correlationId: string;
}

export type ChannelResult = 'SENT' | 'RETRYING' | 'DEAD_LETTERED' | 'SKIPPED_DUPLICATE';

export interface NotifyCustomerResult {
  /** Why nothing was attempted, if so. */
  skipped?: 'NOT_OPTED_IN' | 'ORDER_FINISHED' | 'NO_CHANNEL';
  channels: Partial<Record<NotificationChannel, ChannelResult>>;
}

/** Notification types after which NEARBY makes no sense. */
const TERMINAL_TYPES: NotificationType[] = ['DELIVERED', 'CANCELLED'];

@Injectable()
export class NotifyCustomer {
  private readonly logger = new Logger(NotifyCustomer.name);

  constructor(
    private readonly recipients: OrderRecipientRepository,
    private readonly preferences: PreferencesRepository,
    private readonly log: NotificationLogRepository,
    private readonly directory: RecipientDirectory,
    private readonly delivery: ChannelDelivery,
    private readonly retries: RetryPolicy,
  ) {}

  async execute(command: NotifyCustomerCommand): Promise<NotifyCustomerResult> {
    const { orderId, type, correlationId } = command;

    const customerId = await this.recipients.findCustomerId(orderId);
    if (!customerId) throw new RecipientNotFoundError(orderId);

    const preferences = (await this.preferences.find(customerId)) ?? DEFAULT_PREFERENCES;
    if (type === 'ORDER_CREATED' && !preferences.notifyOnCreated) {
      return { skipped: 'NOT_OPTED_IN', channels: {} };
    }
    // Events of one order travel on different topics (spec 1, consistency
    // rules), so a NEARBY can arrive after the order was delivered.
    if (type === 'NEARBY' && (await this.log.hasAnyType(orderId, TERMINAL_TYPES))) {
      return { skipped: 'ORDER_FINISHED', channels: {} };
    }

    const recipient = await this.directory.load(customerId);
    const channels = selectChannels(preferences, {
      hasEmail: recipient.email !== null,
      hasDevice: recipient.deviceTokens.length > 0,
    });
    if (channels.length === 0) {
      this.logger.warn({ msg: 'Customer not reachable on any enabled channel', orderId, customerId, type, correlationId });
      return { skipped: 'NO_CHANNEL', channels: {} };
    }

    const message = renderCustomerMessage(type, { orderId, customerName: recipient.name });
    const result: NotifyCustomerResult = { channels: {} };

    for (const channel of channels) {
      const key = { orderId, type, channel };
      const entry = await this.log.claim(key, customerId);
      if (entry.status !== 'PENDING') {
        result.channels[channel] = 'SKIPPED_DUPLICATE';
        continue;
      }

      try {
        await this.delivery.deliver(channel, recipient, message);
        await this.log.markSent(entry.id, 1);
        result.channels[channel] = 'SENT';
        this.logger.log({ msg: 'Notification sent', orderId, type, channel, correlationId });
      } catch (error) {
        const outcome = await this.retries.handleFailure({
          logId: entry.id,
          key,
          customerId,
          retryNumber: 0,
          error: describeError(error),
          correlationId,
        });
        result.channels[channel] = outcome;
        this.logger.warn({ msg: 'Notification failed', orderId, type, channel, outcome, error: describeError(error), correlationId });
      }
    }
    return result;
  }
}
