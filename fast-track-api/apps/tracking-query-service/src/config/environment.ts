/**
 * Environment variables of the Tracking Query Service, validated at startup:
 * a missing or mistyped variable stops the service with a clear message.
 *
 * Values come from docker-compose.yml (service `tracking-query-service`) or,
 * when running on the host, from `apps/tracking-query-service/.env` (see
 * `.env.example`). `KAFKA_BROKERS` is read by `KafkaModule` itself, and the
 * HTTP port by main.ts.
 */
import { plainToInstance, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min, validateSync } from 'class-validator';

export class TrackingQueryEnvironment {
  /** PostgreSQL connection string of query-archive-db (ADR-003: database per service). */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** Redis of tracking-cache, e.g. redis://redis:6379/0 (ADR-002). */
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must start with redis:// or rediss://' })
  REDIS_URL: string;

  /**
   * How long a DELIVERED/CANCELLED view stays in Redis before it is served
   * from the archive. ADR-002: 24 h. Shorten locally to watch F3-S5.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  TERMINAL_VIEW_TTL_SECONDS: number = DEFAULT_TERMINAL_VIEW_TTL_SECONDS;
}

/** ADR-002: 24 hours. */
export const DEFAULT_TERMINAL_VIEW_TTL_SECONDS = 86_400;

/**
 * Converts the raw variables (always strings) to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable, so they can all be fixed at once.
 */
export function validateEnvironment(raw: Record<string, unknown>): TrackingQueryEnvironment {
  const environment = plainToInstance(TrackingQueryEnvironment, raw, { enableImplicitConversion: true });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment for tracking-query-service:\n${details}`);
  }
  return environment;
}
