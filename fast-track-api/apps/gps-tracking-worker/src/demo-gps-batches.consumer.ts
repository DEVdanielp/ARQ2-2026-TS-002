// DEMO: remove when the real use case is implemented
/**
 * Temporary consumer of `gps.batches` that only logs what arrives, to check
 * the Kafka wiring end to end before the real GPS processing (ADR-001) exists.
 *
 * Set DEMO_FAIL_HANDLER=true to make the handler always throw, which lets you
 * watch the retries (200 ms, 1 s, 5 s) and the message landing in
 * `gps.batches.dlq`.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';

@Injectable()
export class DemoGpsBatchesConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoGpsBatchesConsumer.name);

  constructor(private readonly consumer: KafkaConsumerService) {}

  // onApplicationBootstrap runs after every onModuleInit, so the producer used
  // for the DLQ is already connected.
  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      topic: Topics.GPS_BATCHES,
      groupId: 'gps-tracking-worker',
      handler: async (envelope, context) => {
        if (process.env.DEMO_FAIL_HANDLER === 'true') {
          throw new Error('Forced failure (DEMO_FAIL_HANDLER=true)');
        }
        this.logger.log({
          msg: 'DEMO received GpsBatchReceived',
          partition: context.partition,
          offset: context.offset,
          key: context.key,
          envelope,
        });
      },
    });
  }
}
