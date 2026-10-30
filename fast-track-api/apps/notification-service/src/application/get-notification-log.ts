/**
 * GetNotificationLog: `GET /notifications/orders/{orderId}` (spec 4.5).
 *
 * - OPERATIONS may read the log of any order.
 * - A CUSTOMER may read only their own orders; for anyone else's order the
 *   answer is "not found", so the API does not reveal that it exists
 *   (spec 2: 404 = "not found (or not visible to the caller)").
 */
import { Injectable } from '@nestjs/common';
import { Roles, type AuthenticatedUser } from '@libs/auth';
import type { NotificationChannel, NotificationStatus, NotificationType } from '../domain/notification.js';
import { OrderNotVisibleError } from './errors.js';
import { NotificationLogRepository, OrderRecipientRepository } from './ports.js';

/** Spec `NotificationLogEntry`. */
export interface NotificationLogView {
  orderId: string;
  type: NotificationType;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts: number;
  sentAt: string | null;
}

@Injectable()
export class GetNotificationLog {
  constructor(
    private readonly recipients: OrderRecipientRepository,
    private readonly log: NotificationLogRepository,
  ) {}

  async execute(orderId: string, caller: AuthenticatedUser): Promise<NotificationLogView[]> {
    const owner = await this.recipients.findCustomerId(orderId);
    const isOperations = caller.roles.includes(Roles.OPERATIONS);

    if (!isOperations && owner !== caller.userId) throw new OrderNotVisibleError(orderId);

    const entries = await this.log.findByOrder(orderId);
    if (isOperations && !owner && entries.length === 0) throw new OrderNotVisibleError(orderId);

    return entries.map((entry) => ({
      orderId: entry.orderId,
      type: entry.type,
      channel: entry.channel,
      status: entry.status,
      attempts: entry.attempts,
      sentAt: entry.sentAt?.toISOString() ?? null,
    }));
  }
}
