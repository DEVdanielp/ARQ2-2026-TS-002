import { createEnvelope, type GpsBatchReceivedPayload } from '@libs/events';
import type { KafkaProducerService } from '@libs/kafka';
import { EventBusUnavailableError } from '../../../application/ports.js';
import { KafkaGpsBatchPublisher, PublisherSettings } from './kafka-gps-batch-publisher.js';

const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

const envelope = createEnvelope<GpsBatchReceivedPayload>({
  eventType: 'GpsBatchReceived',
  schemaVersion: 1,
  producer: 'gps-ingestion-api',
  correlationId: 'corr-1',
  aggregateId: DRIVER,
  aggregateVersion: null,
  payload: { driverId: DRIVER, batchId: 'b-1', receivedAt: '2026-10-18T15:20:07Z', points: [] },
});

function publisherWith(publish: KafkaProducerService['publish'], timeoutMs = 1_000) {
  const producer = { publish: vi.fn(publish) };
  return { producer, publisher: new KafkaGpsBatchPublisher(producer as unknown as KafkaProducerService, new PublisherSettings(timeoutMs)) };
}

describe('KafkaGpsBatchPublisher', () => {
  it('publishes to gps.batches with the driver as key (ADR-001)', async () => {
    const { producer, publisher } = publisherWith(async () => ({ partition: 3 }));

    await publisher.publish(envelope);

    expect(producer.publish).toHaveBeenCalledWith('gps.batches', DRIVER, envelope);
  });

  it('turns a Kafka failure into EventBusUnavailableError', async () => {
    const { publisher } = publisherWith(async () => {
      throw new Error('Local: Broker transport failure');
    });

    await expect(publisher.publish(envelope)).rejects.toThrow(EventBusUnavailableError);
  });

  it('gives up after the timeout instead of holding the request', async () => {
    const { publisher } = publisherWith(() => new Promise(() => {}), 50);

    await expect(publisher.publish(envelope)).rejects.toThrow(/no acknowledgement after 50 ms/);
  });
});
