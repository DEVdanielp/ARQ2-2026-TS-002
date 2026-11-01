/**
 * Environment variables of the Profiles & Assignment Service, validated at
 * startup: a missing or invalid variable stops the service at once with a
 * clear message (passed to `ConfigModule.forRoot({ validate })`).
 *
 * Values come from docker-compose.yml (service `profiles-service`) or, when
 * running on the host, from `apps/profiles-service/.env` (see `.env.example`).
 * `KAFKA_BROKERS` is read by `KafkaModule` itself, and the HTTP port by main.ts.
 */
import { plainToInstance, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import {
  DEFAULT_RETRY_SECONDS,
  DEFAULT_WINDOW_SECONDS,
} from '../domain/assignment-window.js';
import { MAX_CAPACITY, MIN_CAPACITY } from '../domain/profiles.js';

export class ProfilesEnvironment {
  /** PostgreSQL connection string of profiles-db (ADR-003: database per service). */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** Seconds between assignment attempts while no driver is available (spec: 30). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ASSIGNMENT_RETRY_SECONDS?: number;

  /** Seconds after which `AssignmentFailed` is published (spec: 600 = 10 min). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ASSIGNMENT_WINDOW_SECONDS?: number;

  /** How often the scheduler looks for due attempts, in milliseconds. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  ASSIGNMENT_SCHEDULER_INTERVAL_MS?: number;

  /** Capacity of a newly created driver profile (spec 4.1 example: 3). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CAPACITY)
  @Max(MAX_CAPACITY)
  DEFAULT_DRIVER_CAPACITY?: number;
}

/** Defaults of the optional variables (the spec's values). */
export const PROFILES_DEFAULTS = {
  ASSIGNMENT_RETRY_SECONDS: DEFAULT_RETRY_SECONDS,
  ASSIGNMENT_WINDOW_SECONDS: DEFAULT_WINDOW_SECONDS,
  ASSIGNMENT_SCHEDULER_INTERVAL_MS: 1000,
  DEFAULT_DRIVER_CAPACITY: 3,
} as const;

/**
 * Converts the raw variables (always strings) to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable, so they can all be fixed at once.
 */
export function validateEnvironment(
  raw: Record<string, unknown>,
): ProfilesEnvironment {
  // Empty strings (e.g. `ASSIGNMENT_RETRY_SECONDS=` in docker-compose) mean "use the default".
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== ''),
  );
  const environment = plainToInstance(ProfilesEnvironment, present, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment for profiles-service:\n${details}`);
  }
  return environment;
}
