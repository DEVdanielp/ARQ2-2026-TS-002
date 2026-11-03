/**
 * Environment variables of the GPS Tracking Worker, validated at startup.
 *
 * A missing or mistyped variable stops the worker immediately with a clear
 * message (`ConfigModule.forRoot({ validate })`). Values come from
 * docker-compose.yml (service `gps-tracking-worker`) or, on the host, from
 * `apps/gps-tracking-worker/.env` (see `.env.example`). `KAFKA_BROKERS` is
 * read by `KafkaModule` itself.
 */
import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { EtaProviderNames } from '../adapters/out/eta/eta-providers.js';

export class TrackingEnvironment {
  /** PostgreSQL connection string of tracking-db (ADR-003: database per service). */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** NEARBY when the driver is closer than this, in metres (spec 5.4: 500). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  NEARBY_DISTANCE_METERS?: number;

  /** NEARBY when the ETA is below this, in seconds (spec 5.4: 300). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  NEARBY_ETA_SECONDS?: number;

  /**
   * Maps/ETA provider (ADR-020): `openrouteservice` (selected free provider),
   * `osrm` (keyless, development), `http` (generic contract of ADR-018) or
   * `none`. Empty = automatic: ORS_API_KEY set -> openrouteservice,
   * ETA_PROVIDER_URL set -> http, otherwise none (distance only).
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsIn(EtaProviderNames)
  ETA_PROVIDER?: string;

  /**
   * `http`: the endpoint of the generic contract. `openrouteservice` / `osrm`:
   * optional base URL override (self-hosted instance). Empty = provider default.
   */
  @ValidateIf((env: TrackingEnvironment, value) => env.ETA_PROVIDER === 'http' || (value !== undefined && value !== ''))
  @IsUrl({ require_tld: false, require_protocol: true })
  ETA_PROVIDER_URL?: string;

  /** openrouteservice API key (free account at openrouteservice.org). Secret: never commit it. */
  @ValidateIf((env: TrackingEnvironment) => env.ETA_PROVIDER === 'openrouteservice')
  @IsString()
  @IsNotEmpty({ message: 'ORS_API_KEY is required when ETA_PROVIDER=openrouteservice' })
  ORS_API_KEY?: string;

  /** Routing profile, e.g. driving-car (openrouteservice) or driving (osrm). */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @Matches(/^[a-z][a-z-]*$/, { message: 'ETA_ROUTING_PROFILE must look like "driving-car"' })
  ETA_ROUTING_PROFILE?: string;

  /** Local cap of ETA calls per minute; default = the provider's free limit (ADR-020). 0 = no cap. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ETA_RATE_LIMIT_PER_MINUTE?: number;

  /** Local cap of ETA calls per 24 h; default = the provider's free limit (ADR-020). 0 = no cap. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ETA_DAILY_QUOTA?: number;

  /** Only ask the ETA provider within this distance, in metres (ADR-013: 3000). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ETA_LOOKUP_RADIUS_METERS?: number;

  /** At most one ETA call per order per this many seconds (ADR-013: 60). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ETA_MIN_INTERVAL_SECONDS?: number;

  /** Timeout of one ETA call, in milliseconds. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(30_000)
  ETA_TIMEOUT_MS?: number;
}

/** Defaults: spec 5.4 thresholds and ADR-013 limits. */
export const TRACKING_DEFAULTS = {
  NEARBY_DISTANCE_METERS: 500,
  NEARBY_ETA_SECONDS: 300,
  ETA_LOOKUP_RADIUS_METERS: 3_000,
  ETA_MIN_INTERVAL_SECONDS: 60,
  ETA_TIMEOUT_MS: 2_000,
} as const;

/**
 * Converts the raw variables (always strings) to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable, so they can all be fixed at once.
 */
export function validateEnvironment(raw: Record<string, unknown>): TrackingEnvironment {
  const environment = plainToInstance(TrackingEnvironment, raw, { enableImplicitConversion: true });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment for gps-tracking-worker:\n${details}`);
  }
  return environment;
}
