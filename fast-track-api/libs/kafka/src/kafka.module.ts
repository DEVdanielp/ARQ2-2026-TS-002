/**
 * KafkaModule: wires the Kafka client, producer and consumer into a service.
 *
 * Why it exists
 * -------------
 * Every service that talks to Kafka needs the same setup: build a client with
 * the right brokers, connect on startup, disconnect on shutdown. This module
 * does it once, so a service only writes:
 *
 *   @Module({ imports: [KafkaModule.forRoot({ clientId: 'orders-service' })] })
 *
 * and then injects `KafkaProducerService` (to publish) wherever it needs it.
 *
 * One client per service
 * ----------------------
 * Nest providers are singletons by default: the factory below runs once and
 * every class that injects `KAFKA_CLIENT` or `KafkaProducerService` receives
 * the same instance. One producer per process is what Kafka recommends: a
 * producer is thread-safe, batches messages internally, and each extra
 * producer means extra TCP connections and memory on both sides.
 *
 * About the client library
 * ------------------------
 * We use `@confluentinc/kafka-javascript` through its KafkaJS-compatible API
 * (`KafkaJS.Kafka`). It wraps librdkafka, the C client used by most non-Java
 * Kafka clients. KafkaJS-style options must go inside a `kafkaJS: { ... }`
 * block; options outside it are passed to librdkafka as-is.
 */
import { DynamicModule, Module } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { KAFKA_CLIENT, KAFKA_OPTIONS } from './kafka.constants.js';
import {
  resolveKafkaOptions,
  type KafkaModuleOptions,
  type ResolvedKafkaOptions,
} from './kafka.options.js';
import { KafkaProducerService } from './kafka-producer.service.js';

@Module({})
export class KafkaModule {
  /**
   * Registers the Kafka client for the whole application.
   *
   * The module is `global`, so feature modules can inject
   * `KafkaProducerService` without importing `KafkaModule` again. Call
   * `forRoot()` exactly once, in the service's root module.
   *
   * @param options - `clientId` (service name) and optional `brokers`.
   */
  static forRoot(options: KafkaModuleOptions): DynamicModule {
    // Resolve and validate now, so a bad configuration fails at startup.
    const resolved = resolveKafkaOptions(options);

    return {
      module: KafkaModule,
      global: true,
      providers: [
        { provide: KAFKA_OPTIONS, useValue: resolved },
        {
          provide: KAFKA_CLIENT,
          useFactory: (opts: ResolvedKafkaOptions) =>
            new KafkaJS.Kafka({
              kafkaJS: {
                clientId: opts.clientId,
                brokers: opts.brokers,
                // librdkafka is chatty at INFO; warnings and errors are enough
                // in normal operation. Our own services log every publish and
                // every consumed message themselves.
                logLevel: KafkaJS.logLevel.WARN,
              },
            }),
          inject: [KAFKA_OPTIONS],
        },
        KafkaProducerService,
      ],
      exports: [KAFKA_OPTIONS, KAFKA_CLIENT, KafkaProducerService],
    };
  }
}
