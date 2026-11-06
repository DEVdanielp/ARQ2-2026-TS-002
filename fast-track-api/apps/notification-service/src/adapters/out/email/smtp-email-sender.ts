/**
 * EmailSender over SMTP (spec 1: Email Provider; MailHog locally).
 *
 * Locally every email lands in MailHog (http://localhost:8025) instead of a
 * real inbox. Failures (server down, rejected message) are thrown so the use
 * case can schedule a retry.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { traceClient } from '@libs/observability';
import { EmailSender, type EmailMessage } from '../../../application/ports.js';
import type { NotificationEnvironment } from '../../../config/environment.js';

@Injectable()
export class SmtpEmailSender extends EmailSender implements OnModuleDestroy {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;
  private readonly port: number;

  constructor(config: ConfigService<NotificationEnvironment, true>) {
    super();
    this.from = config.get('SMTP_FROM', { infer: true });
    this.host = config.get('SMTP_HOST', { infer: true });
    this.port = config.get('SMTP_PORT', { infer: true });
    this.transporter = createTransport({
      host: this.host,
      port: this.port,
      // MailHog speaks plain SMTP; a real provider would use TLS and auth.
      secure: false,
      // Fail fast: a hung SMTP server must not stall the consumer for minutes.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    // The recipient is not recorded on the span (personal data).
    await traceClient(
      'smtp send',
      { 'network.protocol.name': 'smtp', 'server.address': this.host, 'server.port': this.port },
      () => this.transporter.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text }),
    );
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}
