/**
 * Environment variables of the GPS Ingestion API, validated at startup.
 *
 * The service is stateless, so it needs very little: `KAFKA_BROKERS` is read
 * by `KafkaModule` itself and the HTTP port by main.ts. Values come from
 * docker-compose.yml or, on the host, from `apps/gps-ingestion-api/.env`.
 */
import { plainToInstance, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, validateSync } from 'class-validator';

/** Default wait for Kafka's acknowledgement before answering 503. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;

export class IngestionEnvironment {
  /**
   * Longest wait, in milliseconds, for Kafka to confirm a batch before the
   * request is answered with 503 (see KafkaGpsBatchPublisher).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  GPS_PUBLISH_TIMEOUT_MS?: number;
}

/**
 * Converts the raw variables (always strings) to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable.
 */
export function validateEnvironment(raw: Record<string, unknown>): IngestionEnvironment {
  const environment = plainToInstance(IngestionEnvironment, raw, { enableImplicitConversion: true });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment for gps-ingestion-api:\n${details}`);
  }
  return environment;
}
