/**
 * Delivery building blocks shared by the first send (NotifyCustomer) and the
 * retries (RetryNotification).
 */
import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '../domain/notification.js';
import type { CustomerMessage } from './messages.js';
import { ContactRepository, DeviceRepository, EmailSender, PushSender } from './ports.js';

/** Everything needed to reach one customer, loaded from local copies (ADR-015). */
export interface Recipient {
  customerId: string;
  name: string | null;
  email: string | null;
  deviceTokens: string[];
}

@Injectable()
export class RecipientDirectory {
  constructor(
    private readonly contacts: ContactRepository,
    private readonly devices: DeviceRepository,
  ) {}

  /** Loads the CURRENT contact data and devices (a retry uses fresh data too). */
  async load(customerId: string): Promise<Recipient> {
    const [contact, devices] = await Promise.all([
      this.contacts.find(customerId),
      this.devices.findByCustomer(customerId),
    ]);
    return {
      customerId,
      name: contact?.name ?? null,
      email: contact?.email ?? null,
      deviceTokens: devices.map((device) => device.deviceToken),
    };
  }
}

@Injectable()
export class ChannelDelivery {
  constructor(
    private readonly email: EmailSender,
    private readonly push: PushSender,
  ) {}

  /**
   * Sends the message through one channel.
   *
   * PUSH goes to every registered device; it counts as delivered if at least
   * one device accepted it (a stale token on an old phone must not trigger
   * retries forever).
   *
   * @throws if the provider failed or the customer is not reachable on it.
   */
  async deliver(channel: NotificationChannel, recipient: Recipient, message: CustomerMessage): Promise<void> {
    if (channel === 'EMAIL') {
      if (!recipient.email) throw new Error(`Customer ${recipient.customerId} has no email`);
      await this.email.send({ to: recipient.email, subject: message.subject, text: message.text });
      return;
    }

    if (recipient.deviceTokens.length === 0) throw new Error(`Customer ${recipient.customerId} has no device`);
    const results = await Promise.allSettled(
      recipient.deviceTokens.map((deviceToken) =>
        this.push.send({ deviceToken, title: message.pushTitle, body: message.pushBody }),
      ),
    );
    if (!results.some((result) => result.status === 'fulfilled')) {
      const firstFailure = results.find((result) => result.status === 'rejected');
      throw firstFailure?.reason instanceof Error ? firstFailure.reason : new Error('Push failed on every device');
    }
  }
}

/** Readable text of any thrown value, for logs and `last_error`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
