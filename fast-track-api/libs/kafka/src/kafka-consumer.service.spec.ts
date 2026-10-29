import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createEnvelope, Topics } from '@libs/events';
import { KafkaConsumerService } from './kafka-consumer.service.js';
import type { KafkaProducerService } from './kafka-producer.service.js';
import type { ResolvedKafkaOptions } from './kafka.options.js';

/** A fake KafkaJS client whose consumer lets the test push messages by hand. */
function fakeKafka() {
  let eachMessage: ((payload: unknown) => Promise<void>) | undefined;
  const consumer = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(async (config: { eachMessage: typeof eachMessage }) => {
      eachMessage = config.eachMessage;
    }),
    commitOffsets: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const kafka = { consumer: vi.fn().mockReturnValue(consumer) };
  const deliver = (value: string) =>
    eachMessage!({
      topic: 'gps.batches',
      partition: 5,
      message: { offset: '99', key: Buffer.from('driver-1'), value: Buffer.from(value), headers: {} },
    });
  return { kafka: kafka as unknown as KafkaJS.Kafka, consumer, factory: kafka.consumer, deliver };
}

const options: ResolvedKafkaOptions = {
  clientId: 'gps-tracking-worker',
  brokers: ['localhost:9092'],
  partitionsConsumedConcurrently: 4,
};

const envelope = createEnvelope({
  eventType: 'GpsBatchReceived',
  schemaVersion: 1,
  producer: 'gps-ingestion-api',
  correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
  aggregateId: 'driver-1',
  payload: {},
});

describe('KafkaConsumerService', () => {
  const producer = { send: vi.fn().mockResolvedValue({ partition: 0 }) } as unknown as KafkaProducerService;

  it('creates a consumer with auto-commit off, grouped by service name', async () => {
    const { kafka, consumer, factory } = fakeKafka();
    const service = new KafkaConsumerService(kafka, options, producer);

    await service.subscribe({ topic: Topics.GPS_BATCHES, handler: async () => {} });

    expect(factory).toHaveBeenCalledWith({
      kafkaJS: expect.objectContaining({ groupId: 'gps-tracking-worker', autoCommit: false }),
    });
    expect(consumer.subscribe).toHaveBeenCalledWith({ topics: ['gps.batches'] });
    expect(consumer.run).toHaveBeenCalledWith(
      expect.objectContaining({ partitionsConsumedConcurrently: 4 }),
    );
  });

  it('commits offset + 1 only after the handler finished', async () => {
    const { kafka, consumer, deliver } = fakeKafka();
    const order: string[] = [];
    consumer.commitOffsets.mockImplementation(async () => {
      order.push('commit');
    });
    const service = new KafkaConsumerService(kafka, options, producer);
    await service.subscribe({
      topic: Topics.GPS_BATCHES,
      handler: async () => {
        order.push('handler');
      },
    });

    await deliver(JSON.stringify(envelope));

    expect(order).toEqual(['handler', 'commit']);
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'gps.batches', partition: 5, offset: '100' },
    ]);
  });

  it('does not commit when the message could not be dead-lettered', async () => {
    const { kafka, consumer, deliver } = fakeKafka();
    const failingProducer = {
      send: vi.fn().mockRejectedValue(new Error('DLQ unavailable')),
    } as unknown as KafkaProducerService;
    const service = new KafkaConsumerService(kafka, options, failingProducer);
    await service.subscribe({ topic: Topics.GPS_BATCHES, handler: async () => {} });

    await expect(deliver('{not json')).rejects.toThrow('DLQ unavailable');
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('disconnects its consumers on destroy', async () => {
    const { kafka, consumer } = fakeKafka();
    const service = new KafkaConsumerService(kafka, options, producer);
    await service.subscribe({ topic: Topics.GPS_BATCHES, handler: async () => {} });

    await service.onModuleDestroy();

    expect(consumer.disconnect).toHaveBeenCalledOnce();
  });
});
