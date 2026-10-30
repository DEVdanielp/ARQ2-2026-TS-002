/**
 * TypeORM entities: how each table of notifications-db maps to a class.
 *
 * They belong to the persistence ADAPTER, not to the domain (ADR-014): the
 * domain types in src/domain stay free of database concerns, and repositories
 * (added in later phases) translate between the two.
 *
 * The tables are created by the migrations, never by TypeORM (`synchronize`
 * is off), so these classes must match migrations/*.ts. Every column states
 * its SQL `type` and `name` explicitly: it keeps the mapping readable and does
 * not depend on TypeScript type metadata, which is unreliable for unions such
 * as `string | null`.
 */
import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type {
  DevicePlatform,
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from '../../../domain/notification.js';

@Entity({ name: 'preferences' })
export class PreferencesEntity {
  @PrimaryColumn({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'boolean' })
  push: boolean;

  @Column({ type: 'boolean' })
  email: boolean;

  @Column({ name: 'notify_on_created', type: 'boolean' })
  notifyOnCreated: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'contacts' })
export class ContactEntity {
  @PrimaryColumn({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  @Column({ name: 'aggregate_version', type: 'integer' })
  aggregateVersion: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryColumn({ name: 'device_token', type: 'text' })
  deviceToken: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'text' })
  platform: DevicePlatform;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'order_recipients' })
export class OrderRecipientEntity {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity({ name: 'notification_log' })
export class NotificationLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'text' })
  type: NotificationType;

  @Column({ type: 'text' })
  channel: NotificationChannel;

  @Column({ type: 'text' })
  status: NotificationStatus;

  @Column({ type: 'integer' })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

@Entity({ name: 'processed_events' })
export class ProcessedEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  @Column({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}

/** Every entity, registered explicitly (globs do not work in the bundled build). */
export const NOTIFICATION_ENTITIES = [
  PreferencesEntity,
  ContactEntity,
  DeviceEntity,
  OrderRecipientEntity,
  NotificationLogEntity,
  ProcessedEventEntity,
];
