/**
 * Local copies of data owned by other services (ADR-015).
 *
 * The Notification Service cannot query Profiles or Orders (no shared
 * databases, no synchronous calls: spec 1), so it keeps the few fields it
 * needs, updated from their events.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ContactRepository, OrderRecipientRepository, type CustomerContact } from './ports.js';

@Injectable()
export class ReplicateCustomerContact {
  private readonly logger = new Logger(ReplicateCustomerContact.name);

  constructor(private readonly contacts: ContactRepository) {}

  /**
   * Applies a CustomerContactUpdated. Only a newer `aggregateVersion` wins, so
   * an old event that arrives late cannot overwrite a newer email.
   */
  async execute(contact: CustomerContact, version: number | null): Promise<boolean> {
    if (version === null) {
      this.logger.warn({ msg: 'CustomerContactUpdated without aggregateVersion; last write wins', customerId: contact.customerId });
    }
    return this.contacts.saveIfNewer(contact, version);
  }
}

@Injectable()
export class RecordOrderRecipient {
  constructor(private readonly recipients: OrderRecipientRepository) {}

  /**
   * Remembers the customer of an order (from OrderCreated). Later order and
   * tracking events carry only the orderId, so this is how we know whom to
   * notify. Idempotent: a redelivered OrderCreated changes nothing.
   */
  async execute(orderId: string, customerId: string): Promise<void> {
    await this.recipients.save(orderId, customerId);
  }
}
