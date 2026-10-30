/**
 * PushSender implementations (spec 1: Push Provider = Firebase Cloud Messaging).
 *
 * - FcmPushSender: real pushes, when FCM_CREDENTIALS_FILE points to a
 *   Firebase service-account JSON.
 * - LoggingPushSender: local development without Firebase (the variable is
 *   empty): it only logs the push and reports success.
 *
 * `createPushSender` picks one at startup, so the rest of the service never
 * knows which one is in use.
 */
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { PushSender, type PushMessage } from '../../../application/ports.js';

export class FcmPushSender extends PushSender {
  private readonly messaging: Messaging;

  constructor(credentialsFile: string) {
    super();
    const serviceAccount = JSON.parse(readFileSync(credentialsFile, 'utf8')) as ServiceAccount;
    this.messaging = getMessaging(initializeApp({ credential: cert(serviceAccount) }, 'notification-service'));
  }

  async send(message: PushMessage): Promise<void> {
    // Tokens registered by the app may carry an "fcm:" prefix (spec 4.5 example).
    const token = message.deviceToken.replace(/^fcm:/, '');
    await this.messaging.send({ token, notification: { title: message.title, body: message.body } });
  }
}

export class LoggingPushSender extends PushSender {
  private readonly logger = new Logger('PushSender');

  async send(message: PushMessage): Promise<void> {
    this.logger.log({ msg: 'Push (log only, FCM_CREDENTIALS_FILE is empty)', ...message });
  }
}

export function createPushSender(credentialsFile: string | undefined): PushSender {
  return credentialsFile ? new FcmPushSender(credentialsFile) : new LoggingPushSender();
}
