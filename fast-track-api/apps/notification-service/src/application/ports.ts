/**
 * Ports: what the use cases need from the outside world (ADR-014).
 *
 * In hexagonal architecture the application layer declares interfaces
 * ("ports") and the adapters implement them: TypeORM repositories, SMTP,
 * Firebase. Use cases depend only on these declarations, so they can be
 * tested with in-memory fakes and the infrastructure can change without
 * touching business logic.
 *
 * They are abstract classes (not TypeScript interfaces) because interfaces
 * disappear at runtime, while Nest needs a runtime token to inject an
 * implementation: `{ provide: PreferencesRepository, useClass: TypeOrm... }`.
 */
import type { EventEnvelope } from '@libs/events';
import type {
  DevicePlatform,
  NotificationChannel,
  NotificationPreferences,
  NotificationStatus,
  NotificationType,
} from '../domain/notification.js';

// ---------------------------------------------------------------- data shapes

/** Local copy of the customer's contact data (ADR-015). */
export interface CustomerContact {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface Device {
  deviceToken: string;
  platform: DevicePlatform;
}

/** Identifies one notification: the UNIQUE key of notification_log. */
export interface NotificationKey {
  orderId: string;
  type: NotificationType;
  channel: NotificationChannel;
}

export interface NotificationLogEntry extends NotificationKey {
  id: string;
  customerId: string;
  status: NotificationStatus;
  /** Send attempts so far (first send + retries). */
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
}

/** Payload of the `NotificationRetry` event (spec 5.4). */
export interface NotificationRetryPayload {
  orderId: string;
  customerId: string;
  type: NotificationType;
  channel: NotificationChannel;
  /** Retry number: 1, 2 or 3. */
  attempt: number;
  /** Not to be processed before this ISO time. */
  notBefore: string;
  lastError: string;
}

// ---------------------------------------------------------------- repositories

export abstract class PreferencesRepository {
  /** Null when the customer never saved preferences. */
  abstract find(customerId: string): Promise<NotificationPreferences | null>;
  abstract save(customerId: string, preferences: NotificationPreferences): Promise<void>;
}

export abstract class DeviceRepository {
  /** Inserts or moves the token to this customer. */
  abstract upsert(customerId: string, device: Device): Promise<void>;
  abstract findByCustomer(customerId: string): Promise<Device[]>;
}

export abstract class ContactRepository {
  abstract find(customerId: string): Promise<CustomerContact | null>;
  /**
   * Stores the contact only if `version` is newer than the stored one, so a
   * late or duplicate event never overwrites newer data (spec 5.4).
   * A null version always applies (last write wins).
   * @returns whether the contact was stored.
   */
  abstract saveIfNewer(contact: CustomerContact, version: number | null): Promise<boolean>;
}

export abstract class OrderRecipientRepository {
  /** Idempotent: saving the same order twice keeps the first value. */
  abstract save(orderId: string, customerId: string): Promise<void>;
  abstract findCustomerId(orderId: string): Promise<string | null>;
}

export abstract class ProcessedEventRepository {
  abstract isProcessed(eventId: string): Promise<boolean>;
  abstract markProcessed(eventId: string, eventType: string): Promise<void>;
}

export abstract class NotificationLogRepository {
  /**
   * Inserts the row as PENDING if it does not exist, then returns the row.
   * Thanks to UNIQUE(order_id, type, channel), only one caller ever gets a
   * PENDING row it created; a duplicate event gets the existing row.
   */
  abstract claim(key: NotificationKey, customerId: string): Promise<NotificationLogEntry>;
  abstract find(key: NotificationKey): Promise<NotificationLogEntry | null>;
  abstract findByOrder(orderId: string): Promise<NotificationLogEntry[]>;
  abstract hasAnyType(orderId: string, types: NotificationType[]): Promise<boolean>;
  abstract markSent(id: string, attempts: number): Promise<void>;
  /**
   * Marks the row RETRYING and schedules the retry, ATOMICALLY: both writes
   * share one transaction through the outbox (ADR-005, ADR-017).
   */
  abstract markRetrying(
    id: string,
    attempts: number,
    error: string,
    retry: EventEnvelope<NotificationRetryPayload>,
    publishAfter: Date,
  ): Promise<void>;
  /** Marks the row DEAD_LETTERED and sends the message to notifications.retry.dlq, atomically. */
  abstract markDeadLettered(
    id: string,
    attempts: number,
    error: string,
    deadLetter: EventEnvelope<NotificationRetryPayload>,
  ): Promise<void>;
}

// ---------------------------------------------------------------- channels

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface PushMessage {
  deviceToken: string;
  title: string;
  body: string;
}

/** Throws when the provider fails; the caller decides whether to retry. */
export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}

/** Throws when the provider fails; the caller decides whether to retry. */
export abstract class PushSender {
  abstract send(message: PushMessage): Promise<void>;
}

// ---------------------------------------------------------------- settings

/** Business settings read from the environment. */
export class NotificationSettings {
  constructor(
    /** Mailbox of the operations staff (AssignmentFailed alerts). */
    readonly opsAlertEmail: string,
    /** Waits before retry 1, 2, 3, in seconds (spec: 60, 300, 900). */
    readonly retryBackoffSeconds: readonly number[],
  ) {}
}
