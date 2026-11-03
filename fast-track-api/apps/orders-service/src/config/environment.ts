/**
 * Environment variables of the Orders Service, validated at startup: a missing
 * or invalid variable stops the service at once with a clear message (passed
 * to `ConfigModule.forRoot({ validate })`).
 *
 * Values come from docker-compose.yml (service `orders-service`) or, when
 * running on the host, from `apps/orders-service/.env` (see `.env.example`).
 * `KAFKA_BROKERS` is read by `KafkaModule` itself, and the HTTP port by main.ts.
 */
import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsString, validateSync } from 'class-validator';

export class OrdersEnvironment {
  /** PostgreSQL connection string of orders-db (ADR-003: database per service). */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;
}

/**
 * Converts the raw variables to typed values and validates them.
 *
 * @throws {Error} listing every invalid variable, so they can all be fixed at once.
 */
export function validateEnvironment(
  raw: Record<string, unknown>,
): OrdersEnvironment {
  const environment = plainToInstance(OrdersEnvironment, raw);
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment for orders-service:\n${details}`);
  }
  return environment;
}
