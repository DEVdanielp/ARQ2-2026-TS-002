import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createEnvelope, Topics } from '@libs/events';
import { KafkaProducerService } from './kafka-producer.service.js';
import type { ResolvedKafkaOptions } from './kafka.options.js';

/** A fake KafkaJS client: records the producer config and the sent records. */
function fakeKafka() {
  const producer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue([{ topicName: 'gps.batches', partition: 7, errorCode: 0, offset: '42' }]),
  };
  const kafka = { producer: vi.fn().mockReturnValue(producer) };
  return { kafka: kafka as unknown as KafkaJS.Kafka, producer, factory: kafka.producer };
}

const options: ResolvedKafkaOptions = {
  clientId: 'gps-ingestion-api',
  brokers: ['localhost:9092'],
  partitionsConsumedConcurrently: 1,
};

const envelope = createEnvelope({
  eventType: 'GpsBatchReceived',
  schemaVersion: 1,
  producer: 'gps-ingestion-api',
  correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
  aggregateId: 'driver-1',
  payload: { points: [] },
});

describe('KafkaProducerService', () => {
  it('creates an idempotent producer with acks=all', () => {
    const { kafka, factory } = fakeKafka();

    new KafkaProducerService(kafka, options);

    expect(factory).toHaveBeenCalledWith({
      kafkaJS: expect.objectContaining({ acks: -1, idempotent: true }),
    });
  });

  it('publishes the envelope as JSON with the key and the spec headers', async () => {
    const { kafka, producer } = fakeKafka();
    const service = new KafkaProducerService(kafka, options);

    const result = await service.publish(Topics.GPS_BATCHES, 'driver-1', envelope);

    expect(result).toEqual({ partition: 7, offset: '42' });
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'gps.batches',
      messages: [
        {
          key: 'driver-1',
          value: JSON.stringify(envelope),
          headers: { eventType: 'GpsBatchReceived', correlationId: envelope.correlationId },
        },
      ],
    });
  });

  it('refuses to publish without a key', async () => {
    const { kafka, producer } = fakeKafka();
    const service = new KafkaProducerService(kafka, options);

    await expect(service.publish(Topics.GPS_BATCHES, '', envelope)).rejects.toThrow(/without a key/);
    expect(producer.send).not.toHaveBeenCalled();
  });

  it('rethrows broker errors so callers (e.g. the outbox) can retry', async () => {
    const { kafka, producer } = fakeKafka();
    producer.send.mockRejectedValueOnce(new Error('broker down'));
    const service = new KafkaProducerService(kafka, options);

    await expect(service.publish(Topics.GPS_BATCHES, 'driver-1', envelope)).rejects.toThrow('broker down');
  });

  it('connects on init and disconnects on destroy', async () => {
    const { kafka, producer } = fakeKafka();
    const service = new KafkaProducerService(kafka, options);

    await service.onModuleInit();
    await service.onModuleDestroy();

    expect(producer.connect).toHaveBeenCalledOnce();
    expect(producer.disconnect).toHaveBeenCalledOnce();
  });
});
