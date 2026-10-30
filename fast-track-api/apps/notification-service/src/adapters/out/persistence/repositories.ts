/**
 * PostgreSQL implementations of the repository ports (application/ports.ts).
 *
 * Idempotency lives in SQL, not in "check then write" code: two concurrent
 * writers cannot both pass a check, but the database's UNIQUE constraints and
 * `ON CONFLICT` clauses decide atomically.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { dlqTopic, Topics, type EventEnvelope } from '@libs/events';
import { OutboxService } from '@libs/outbox';
import type { NotificationPreferences, NotificationType } from '../../../domain/notification.js';
import {
  ContactRepository,
  DeviceRepository,
  NotificationLogRepository,
  OrderRecipientRepository,
  PreferencesRepository,
  ProcessedEventRepository,
  type CustomerContact,
  type Device,
  type NotificationKey,
  type NotificationLogEntry,
  type NotificationRetryPayload,
} from '../../../application/ports.js';
import {
  ContactEntity,
  DeviceEntity,
  NotificationLogEntity,
  OrderRecipientEntity,
  PreferencesEntity,
  ProcessedEventEntity,
} from './entities.js';

@Injectable()
export class TypeOrmPreferencesRepository extends PreferencesRepository {
  constructor(@InjectRepository(PreferencesEntity) private readonly repo: Repository<PreferencesEntity>) {
    super();
  }

  async find(customerId: string): Promise<NotificationPreferences | null> {
    const row = await this.repo.findOneBy({ customerId });
    return row ? { push: row.push, email: row.email, notifyOnCreated: row.notifyOnCreated } : null;
  }

  async save(customerId: string, preferences: NotificationPreferences): Promise<void> {
    await this.repo.upsert({ customerId, ...preferences, updatedAt: new Date() }, ['customerId']);
  }
}

@Injectable()
export class TypeOrmDeviceRepository extends DeviceRepository {
  constructor(@InjectRepository(DeviceEntity) private readonly repo: Repository<DeviceEntity>) {
    super();
  }

  async upsert(customerId: string, device: Device): Promise<void> {
    // Keyed by token: re-registering moves the token to the current customer.
    await this.repo.upsert({ ...device, customerId, updatedAt: new Date() }, ['deviceToken']);
  }

  async findByCustomer(customerId: string): Promise<Device[]> {
    const rows = await this.repo.findBy({ customerId });
    return rows.map((row) => ({ deviceToken: row.deviceToken, platform: row.platform }));
  }
}

@Injectable()
export class TypeOrmContactRepository extends ContactRepository {
  constructor(
    @InjectRepository(ContactEntity) private readonly repo: Repository<ContactEntity>,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async find(customerId: string): Promise<CustomerContact | null> {
    const row = await this.repo.findOneBy({ customerId });
    return row ? { customerId: row.customerId, name: row.name, email: row.email, phone: row.phone } : null;
  }

  async saveIfNewer(contact: CustomerContact, version: number | null): Promise<boolean> {
    // One atomic statement: insert, or update only if the incoming version is
    // newer. RETURNING yields a row only when something was written.
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO contacts (customer_id, name, email, phone, aggregate_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (customer_id) DO UPDATE
          SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
              aggregate_version = EXCLUDED.aggregate_version, updated_at = now()
        WHERE $6::boolean OR contacts.aggregate_version < EXCLUDED.aggregate_version
       RETURNING customer_id`,
      [contact.customerId, contact.name, contact.email, contact.phone, version ?? 0, version === null],
    );
    return rows.length > 0;
  }
}

@Injectable()
export class TypeOrmOrderRecipientRepository extends OrderRecipientRepository {
  constructor(
    @InjectRepository(OrderRecipientEntity) private readonly repo: Repository<OrderRecipientEntity>,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async save(orderId: string, customerId: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO order_recipients (order_id, customer_id) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
      [orderId, customerId],
    );
  }

  async findCustomerId(orderId: string): Promise<string | null> {
    return (await this.repo.findOneBy({ orderId }))?.customerId ?? null;
  }
}

@Injectable()
export class TypeOrmProcessedEventRepository extends ProcessedEventRepository {
  constructor(
    @InjectRepository(ProcessedEventEntity) private readonly repo: Repository<ProcessedEventEntity>,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async isProcessed(eventId: string): Promise<boolean> {
    return (await this.repo.countBy({ eventId })) > 0;
  }

  async markProcessed(eventId: string, eventType: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType],
    );
  }
}

@Injectable()
export class TypeOrmNotificationLogRepository extends NotificationLogRepository {
  constructor(
    @InjectRepository(NotificationLogEntity) private readonly repo: Repository<NotificationLogEntity>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async claim(key: NotificationKey, customerId: string): Promise<NotificationLogEntry> {
    // If the row exists, DO NOTHING keeps it untouched; either way we then
    // read the row and the caller decides by its status.
    await this.dataSource.query(
      `INSERT INTO notification_log (order_id, customer_id, type, channel, status, attempts)
       VALUES ($1, $2, $3, $4, 'PENDING', 0)
       ON CONFLICT ON CONSTRAINT notification_log_order_type_channel_uq DO NOTHING`,
      [key.orderId, customerId, key.type, key.channel],
    );
    const row = await this.repo.findOneByOrFail({ orderId: key.orderId, type: key.type, channel: key.channel });
    return toEntry(row);
  }

  async find(key: NotificationKey): Promise<NotificationLogEntry | null> {
    const row = await this.repo.findOneBy({ orderId: key.orderId, type: key.type, channel: key.channel });
    return row ? toEntry(row) : null;
  }

  async findByOrder(orderId: string): Promise<NotificationLogEntry[]> {
    const rows = await this.repo.find({ where: { orderId }, order: { createdAt: 'ASC' } });
    return rows.map(toEntry);
  }

  async hasAnyType(orderId: string, types: NotificationType[]): Promise<boolean> {
    return (await this.repo.countBy({ orderId, type: In(types) })) > 0;
  }

  async markSent(id: string, attempts: number): Promise<void> {
    await this.repo.update({ id }, { status: 'SENT', attempts, sentAt: new Date(), lastError: null, updatedAt: new Date() });
  }

  async markRetrying(
    id: string,
    attempts: number,
    error: string,
    retry: EventEnvelope<NotificationRetryPayload>,
    publishAfter: Date,
  ): Promise<void> {
    // Same transaction for the log update and the scheduled event (ADR-005):
    // a crash can never leave a RETRYING row without its retry, or vice versa.
    await this.dataSource.transaction(async (manager) => {
      await manager.update(NotificationLogEntity, { id }, { status: 'RETRYING', attempts, lastError: error, updatedAt: new Date() });
      await this.outbox.enqueue(manager, {
        topic: Topics.NOTIFICATIONS_RETRY,
        key: retry.payload.orderId,
        envelope: retry,
        publishAfter,
      });
    });
  }

  async markDeadLettered(
    id: string,
    attempts: number,
    error: string,
    deadLetter: EventEnvelope<NotificationRetryPayload>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(NotificationLogEntity, { id }, { status: 'DEAD_LETTERED', attempts, lastError: error, updatedAt: new Date() });
      await this.outbox.enqueue(manager, {
        topic: dlqTopic(Topics.NOTIFICATIONS_RETRY),
        key: deadLetter.payload.orderId,
        envelope: deadLetter,
      });
    });
  }
}

function toEntry(row: NotificationLogEntity): NotificationLogEntry {
  return {
    id: row.id,
    orderId: row.orderId,
    customerId: row.customerId,
    type: row.type,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    sentAt: row.sentAt,
  };
}
