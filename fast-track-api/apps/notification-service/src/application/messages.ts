/**
 * Texts of the notifications. Kept in one place so wording changes do not
 * touch the delivery logic.
 */
import type { NotificationType } from '../domain/notification.js';

export interface CustomerMessage {
  subject: string;
  text: string;
  pushTitle: string;
  pushBody: string;
}

const TEMPLATES: Record<NotificationType, { title: string; line: string }> = {
  ORDER_CREATED: { title: 'Order received', line: 'we received your order and are looking for a driver.' },
  ON_THE_WAY: { title: 'Your order is on the way', line: 'your driver picked up your order and is on the way.' },
  NEARBY: { title: 'Your driver is almost there', line: 'your driver is less than 5 minutes away. Get ready!' },
  DELIVERED: { title: 'Order delivered', line: 'your order was delivered. Thank you for using FastTrack!' },
  CANCELLED: { title: 'Order cancelled', line: 'your order was cancelled.' },
};

/** Builds the email and push texts for a customer notification. */
export function renderCustomerMessage(
  type: NotificationType,
  context: { orderId: string; customerName: string | null },
): CustomerMessage {
  const { title, line } = TEMPLATES[type];
  const greeting = context.customerName ? `Hi ${context.customerName}` : 'Hi';
  return {
    subject: `FastTrack: ${title}`,
    text: `${greeting}, ${line}\n\nOrder: ${context.orderId}\n\nFastTrack`,
    pushTitle: title,
    pushBody: `${greeting}, ${line}`,
  };
}

/** Email for the operations staff when no driver could be assigned. */
export function renderAssignmentFailedAlert(payload: {
  orderId: string;
  attempts?: number;
  windowStartedAt?: string;
  failedAt?: string;
}): { subject: string; text: string } {
  return {
    subject: `FastTrack ALERT: no driver assigned to order ${payload.orderId}`,
    text: [
      `No driver could be assigned to order ${payload.orderId}.`,
      payload.attempts !== undefined ? `Assignment attempts: ${payload.attempts}` : undefined,
      payload.windowStartedAt ? `Window started at: ${payload.windowStartedAt}` : undefined,
      payload.failedAt ? `Failed at: ${payload.failedAt}` : undefined,
      '',
      'Please assign a driver manually or contact the customer.',
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  };
}
