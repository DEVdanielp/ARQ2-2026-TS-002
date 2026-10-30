/**
 * Root module of the Notification Service (F5): wires every layer together.
 *
 *   adapters/in   (HTTP controller, Kafka consumer)
 *        │ call
 *   application   (use cases + ports)
 *        │ implemented by
 *   adapters/out  (PostgreSQL repositories, SMTP, FCM)
 *
 * This file is the only place that knows which implementation backs each
 * port (ADR-014).
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { OutboxModule } from '@libs/outbox';
import { parseBackoff, validateEnvironment, type NotificationEnvironment } from './config/environment.js';
import { PersistenceModule } from './adapters/out/persistence/persistence.module.js';
import { SmtpEmailSender } from './adapters/out/email/smtp-email-sender.js';
import { createPushSender } from './adapters/out/push/push-senders.js';
import { NotificationsController } from './adapters/in/http/notifications.controller.js';
import { NotificationEventsConsumer } from './adapters/in/kafka/notification-events.consumer.js';
import { EmailSender, NotificationSettings, PushSender } from './application/ports.js';
import { ChannelDelivery, RecipientDirectory } from './application/delivery.js';
import { RetryPolicy } from './application/retry-policy.js';
import { ManagePreferences, RegisterDevice } from './application/preferences.use-cases.js';
import { RecordOrderRecipient, ReplicateCustomerContact } from './application/replication.use-cases.js';
import { NotifyCustomer } from './application/notify-customer.js';
import { RetryNotification } from './application/retry-notification.js';
import { AlertOperations } from './application/alert-operations.js';
import { GetNotificationLog } from './application/get-notification-log.js';

type Config = ConfigService<NotificationEnvironment, true>;

@Module({
  imports: [
    // Must stay FIRST: ConfigModule.forRoot() loads the .env file into
    // process.env synchronously, and KafkaModule.forRoot() below reads
    // KAFKA_BROKERS from process.env when this array is evaluated.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the file does not exist and
      // the variables come from docker-compose.yml.
      envFilePath: 'apps/notification-service/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'notification-service' }),
    PersistenceModule,
    OutboxModule.forRoot(),
  ],
  controllers: [NotificationsController],
  providers: [
    // Settings and channel adapters (outbound ports).
    {
      provide: NotificationSettings,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new NotificationSettings(
          config.get('OPS_ALERT_EMAIL', { infer: true }),
          parseBackoff(config.get('NOTIFICATION_RETRY_BACKOFF_SECONDS', { infer: true })),
        ),
    },
    { provide: EmailSender, useClass: SmtpEmailSender },
    {
      provide: PushSender,
      inject: [ConfigService],
      useFactory: (config: Config) => createPushSender(config.get('FCM_CREDENTIALS_FILE', { infer: true })),
    },

    // Application layer.
    RecipientDirectory,
    ChannelDelivery,
    RetryPolicy,
    ManagePreferences,
    RegisterDevice,
    RecordOrderRecipient,
    ReplicateCustomerContact,
    NotifyCustomer,
    RetryNotification,
    AlertOperations,
    GetNotificationLog,

    // Inbound Kafka adapter.
    NotificationEventsConsumer,
  ],
})
export class NotificationServiceModule {}
