/**
 * AlertOperations: email to the operations mailbox when no driver could be
 * assigned to an order (AssignmentFailed, spec 5.4).
 *
 * Idempotency by eventId (processed_events): the event is marked AFTER the
 * email was accepted, so a crash in between re-sends the alert instead of
 * losing it. If SMTP fails, the error is rethrown: the Kafka consumer retries
 * (200 ms, 1 s, 5 s) and finally parks the event in assignment.events.dlq.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@libs/events';
import { renderAssignmentFailedAlert } from './messages.js';
import { EmailSender, NotificationSettings, ProcessedEventRepository } from './ports.js';

export interface AssignmentFailedPayload {
  orderId: string;
  attempts?: number;
  windowStartedAt?: string;
  failedAt?: string;
}

@Injectable()
export class AlertOperations {
  private readonly logger = new Logger(AlertOperations.name);

  constructor(
    private readonly processed: ProcessedEventRepository,
    private readonly email: EmailSender,
    private readonly settings: NotificationSettings,
  ) {}

  /** @returns false if this event was already handled. */
  async execute(envelope: EventEnvelope<AssignmentFailedPayload>): Promise<boolean> {
    if (await this.processed.isProcessed(envelope.eventId)) return false;

    const alert = renderAssignmentFailedAlert(envelope.payload);
    await this.email.send({ to: this.settings.opsAlertEmail, ...alert });
    await this.processed.markProcessed(envelope.eventId, envelope.eventType);

    this.logger.log({ msg: 'Operations alerted', orderId: envelope.payload.orderId, correlationId: envelope.correlationId });
    return true;
  }
}
