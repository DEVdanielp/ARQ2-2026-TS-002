/**
 * Environment variables of the Notification Service, validated at startup.
 *
 * Why it exists
 * -------------
 * A missing or mistyped variable (for example a wrong SMTP port) should stop
 * the service immediately with a clear message, not fail an hour later when
 * the first notification is sent. `validateEnvironment` is passed to
 * `ConfigModule.forRoot({ validate })`, so Nest refuses to start if any rule
 * below fails.
 *
 * Values come from docker-compose.yml (service `notification-service`) or, when
 * running on the host, from `apps/notification-service/.env` (see `.env.example`).
 * `KAFKA_BROKERS` is read by `KafkaModule` itself, and the HTTP port by main.ts.
 */
import { plainToInstance, Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, validateSync } from 'class-validator';

export class NotificationEnvironment {
  /** PostgreSQL connection string of notifications-db (ADR-003: database per service). */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** SMTP server of the Email Provider (MailHog locally). */
  @IsString()
  @IsNotEmpty()
  SMTP_HOST: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number;

  /** Sender address of every email. */
  @IsEmail({ require_tld: false })
  SMTP_FROM: string;

  /**
   * Path to the Firebase service-account file. Empty means push notifications
   * are only logged, not sent (local development).
   */
  @IsOptional()
  @IsString()
  FCM_CREDENTIALS_FILE?: string;

  /** Generic mailbox of the operations staff, for AssignmentFailed alerts. */
  @IsEmail({ require_tld: false })
  OPS_ALERT_EMAIL: string;

  /**
   * Waits before retry 1, 2 and 3 of a failed notification, in seconds,
   * comma-separated. Defaults to the spec's 1 min, 5 min, 15 min; set e.g.
   * "5,10,15" locally to watch the whole retry flow in seconds.
   */
  @IsOptional()
  @Matches(/^\d+(,\d+)*$/, { message: 'NOTIFICATION_RETRY_BACKOFF_SECONDS must look like "60,300,900"' })
  NOTIFICATION_RETRY_BACKOFF_SECONDS?: string;
}

/** Spec 5.4 NotificationRetry: 1 min, 5 min, 15 min. */
export const DEFAULT_RETRY_BACKOFF_SECONDS = [60, 300, 900];

export function parseBackoff(value: string | undefined): number[] {
  return value ? value.split(',').map(Number) : DEFAULT_RETRY_BACKOFF_SECONDS;
}

/**
 * Converts the raw variables (always strings) to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable, so they can all be fixed at once.
 */
export function validateEnvironment(raw: Record<string, unknown>): NotificationEnvironment {
  const environment = plainToInstance(NotificationEnvironment, raw, { enableImplicitConversion: true });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment for notification-service:\n${details}`);
  }
  return environment;
}
