/**
 * In-memory implementations of the ports, for unit tests only.
 *
 * They behave like the real adapters (same rules: UNIQUE claim, newer-version
 * wins, ...) without a database, so use-case tests are fast and focus on
 * business logic. This is the payoff of the ports in ports.ts.
 */
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@libs/events';
import type { NotificationPreferences, NotificationType } from '../../domain/notification.js';
import {
  ContactRepository,
  DeviceRepository,
  EmailSender,
  NotificationLogRepository,
  NotificationSettings,
  OrderRecipientRepository,
  PreferencesRepository,
  ProcessedEventRepository,
  PushSender,
  type CustomerContact,
  type Device,
  type EmailMessage,
  type NotificationKey,
  type NotificationLogEntry,
  type NotificationRetryPayload,
  type PushMessage,
} from '../ports.js';

export class InMemoryPreferences extends PreferencesRepository {
  readonly rows = new Map<string, NotificationPreferences>();
  async find(customerId: string) {
    return this.rows.get(customerId) ?? null;
  }
  async save(customerId: string, preferences: NotificationPreferences) {
    this.rows.set(customerId, { ...preferences });
  }
}

export class InMemoryDevices extends DeviceRepository {
  readonly rows = new Map<string, { customerId: string; device: Device }>();
  async upsert(customerId: string, device: Device) {
    this.rows.set(device.deviceToken, { customerId, device });
  }
  async findByCustomer(customerId: string) {
    return [...this.rows.values()].filter((row) => row.customerId === customerId).map((row) => row.device);
  }
}

export class InMemoryContacts extends ContactRepository {
  readonly rows = new Map<string, { contact: CustomerContact; version: number }>();
  async find(customerId: string) {
    return this.rows.get(customerId)?.contact ?? null;
  }
  async saveIfNewer(contact: CustomerContact, version: number | null) {
    const current = this.rows.get(contact.customerId);
    if (version !== null && current && current.version >= version) return false;
    this.rows.set(contact.customerId, { contact, version: version ?? 0 });
    return true;
  }
}

export class InMemoryRecipients extends OrderRecipientRepository {
  readonly rows = new Map<string, string>();
  async save(orderId: string, customerId: string) {
    if (!this.rows.has(orderId)) this.rows.set(orderId, customerId);
  }
  async findCustomerId(orderId: string) {
    return this.rows.get(orderId) ?? null;
  }
}

export class InMemoryProcessedEvents extends ProcessedEventRepository {
  readonly ids = new Set<string>();
  async isProcessed(eventId: string) {
    return this.ids.has(eventId);
  }
  async markProcessed(eventId: string) {
    this.ids.add(eventId);
  }
}

/** Also records what would have been written to the outbox. */
export class InMemoryNotificationLog extends NotificationLogRepository {
  readonly rows: NotificationLogEntry[] = [];
  readonly outbox: Array<{ topic: string; envelope: EventEnvelope<NotificationRetryPayload>; publishAfter?: Date }> = [];

  private findRow(key: NotificationKey) {
    return this.rows.find((r) => r.orderId === key.orderId && r.type === key.type && r.channel === key.channel);
  }
  private byId(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`No log row ${id}`);
    return row;
  }

  async claim(key: NotificationKey, customerId: string) {
    const existing = this.findRow(key);
    if (existing) return { ...existing };
    const row: NotificationLogEntry = {
      ...key,
      id: randomUUID(),
      customerId,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      sentAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }
  async find(key: NotificationKey) {
    const row = this.findRow(key);
    return row ? { ...row } : null;
  }
  async findByOrder(orderId: string) {
    return this.rows.filter((r) => r.orderId === orderId).map((r) => ({ ...r }));
  }
  async hasAnyType(orderId: string, types: NotificationType[]) {
    return this.rows.some((r) => r.orderId === orderId && types.includes(r.type));
  }
  async markSent(id: string, attempts: number) {
    Object.assign(this.byId(id), { status: 'SENT', attempts, sentAt: new Date(), lastError: null });
  }
  async markRetrying(id: string, attempts: number, error: string, retry: EventEnvelope<NotificationRetryPayload>, publishAfter: Date) {
    Object.assign(this.byId(id), { status: 'RETRYING', attempts, lastError: error });
    this.outbox.push({ topic: 'notifications.retry', envelope: retry, publishAfter });
  }
  async markDeadLettered(id: string, attempts: number, error: string, deadLetter: EventEnvelope<NotificationRetryPayload>) {
    Object.assign(this.byId(id), { status: 'DEAD_LETTERED', attempts, lastError: error });
    this.outbox.push({ topic: 'notifications.retry.dlq', envelope: deadLetter });
  }
}

/** Records sent messages; set `failing = true` to simulate a provider outage. */
export class FakeEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];
  failing = false;
  async send(message: EmailMessage) {
    if (this.failing) throw new Error('SMTP 421 Service not available');
    this.sent.push(message);
  }
}

export class FakePushSender extends PushSender {
  readonly sent: PushMessage[] = [];
  failing = false;
  async send(message: PushMessage) {
    if (this.failing) throw new Error('FCM 503 Service Unavailable');
    this.sent.push(message);
  }
}

export const TEST_SETTINGS = new NotificationSettings('ops@fasttrack.local', [60, 300, 900]);
