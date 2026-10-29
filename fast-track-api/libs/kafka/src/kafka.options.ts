/**
 * Configuration of the Kafka library and the helpers that resolve it.
 *
 * Why it exists
 * -------------
 * Every service needs the same two settings to talk to Kafka: who it is
 * (`clientId`) and where the brokers are (`brokers`). Brokers change between
 * environments (`kafka:19092` inside Docker, `localhost:9092` from the host),
 * so they come from the `KAFKA_BROKERS` environment variable by default, which
 * docker-compose.yml already sets for every service.
 */
import { Logger } from '@nestjs/common';

/** Options accepted by `KafkaModule.forRoot()`. */
export interface KafkaModuleOptions {
  /**
   * Name of the service, e.g. `'gps-ingestion-api'`. It is sent to the broker
   * so logs and metrics on the Kafka side show who is connected, and it is the
   * default consumer group id (see `KafkaConsumerService.subscribe`).
   */
  clientId: string;
  /**
   * Broker addresses (`host:port`). Defaults to the comma-separated
   * `KAFKA_BROKERS` environment variable.
   */
  brokers?: string[];
  /**
   * How many partitions a consumer may process at the same time. Messages of
   * one partition are always processed one by one, so this never breaks the
   * per-key ordering. Defaults to {@link DEFAULT_PARTITIONS_CONSUMED_CONCURRENTLY}.
   */
  partitionsConsumedConcurrently?: number;
}

/** Options after defaults have been applied; this is what gets injected. */
export interface ResolvedKafkaOptions {
  clientId: string;
  brokers: string[];
  partitionsConsumedConcurrently: number;
}

/** Broker used when neither `brokers` nor `KAFKA_BROKERS` is set (local dev from the host). */
export const DEFAULT_BROKERS = ['localhost:9092'];

/**
 * Default parallelism across partitions. A small number keeps resource usage
 * low in local development; each service can raise it in `forRoot()`.
 */
export const DEFAULT_PARTITIONS_CONSUMED_CONCURRENTLY = 4;

/**
 * Parses a comma-separated broker list such as `"kafka:19092, kafka2:19092"`.
 * Empty entries are ignored.
 */
export function parseBrokers(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

/**
 * Applies defaults and validates the options given to `KafkaModule.forRoot()`.
 *
 * Broker precedence: explicit `brokers` option, then `KAFKA_BROKERS`, then
 * `localhost:9092` (with a warning, so a missing variable is visible).
 *
 * @param env - environment variables; injectable to make this testable.
 * @throws {Error} if `clientId` is empty or the concurrency is not a positive integer.
 */
export function resolveKafkaOptions(
  options: KafkaModuleOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKafkaOptions {
  if (!options.clientId?.trim()) {
    throw new Error('KafkaModule.forRoot(): clientId (the service name) is required');
  }

  let brokers = options.brokers?.length ? options.brokers : parseBrokers(env.KAFKA_BROKERS);
  if (brokers.length === 0) {
    new Logger('KafkaModule').warn(
      `KAFKA_BROKERS is not set; falling back to ${DEFAULT_BROKERS.join(',')}`,
    );
    brokers = DEFAULT_BROKERS;
  }

  const partitionsConsumedConcurrently =
    options.partitionsConsumedConcurrently ?? DEFAULT_PARTITIONS_CONSUMED_CONCURRENTLY;
  if (!Number.isInteger(partitionsConsumedConcurrently) || partitionsConsumedConcurrently < 1) {
    throw new Error('KafkaModule.forRoot(): partitionsConsumedConcurrently must be a positive integer');
  }

  return { clientId: options.clientId, brokers, partitionsConsumedConcurrently };
}
