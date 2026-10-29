/**
 * KafkaProducerService: the single Kafka producer of a service.
 *
 * Why it exists
 * -------------
 * Owns the lifecycle of the producer connection: it connects when the Nest
 * application starts and disconnects cleanly when it stops.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { KAFKA_CLIENT, KAFKA_OPTIONS } from './kafka.constants.js';
import type { ResolvedKafkaOptions } from './kafka.options.js';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: KafkaJS.Producer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: KafkaJS.Kafka,
    @Inject(KAFKA_OPTIONS) private readonly options: ResolvedKafkaOptions,
  ) {
    this.producer = kafka.producer();
  }

  /**
   * Connects the producer when the module starts.
   *
   * If Kafka is unreachable, `connect()` retries a few times and then throws,
   * which makes the application fail to start. That is intended: a service
   * that cannot publish events should not report itself as healthy. Docker
   * restarts it (`restart: unless-stopped`) until Kafka is available.
   */
  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log(
      `Producer connected (clientId=${this.options.clientId}, brokers=${this.options.brokers.join(',')})`,
    );
  }

  /**
   * Disconnects the producer when the application shuts down.
   *
   * Why a clean disconnect matters: the producer keeps messages in an
   * in-memory buffer and sends them in batches. `disconnect()` flushes that
   * buffer and waits for the broker's acknowledgements, so events accepted by
   * `publish()` are not lost when the process stops. It also closes the TCP
   * connections, so the broker frees their resources immediately instead of
   * waiting for a timeout.
   *
   * Nest only runs this hook on SIGTERM/SIGINT if `main.ts` calls
   * `app.enableShutdownHooks()`.
   */
  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Producer disconnected');
  }
}
