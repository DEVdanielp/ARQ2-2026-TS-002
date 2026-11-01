import { createEnvelope } from '@libs/events';
import type { KafkaConsumerService } from '@libs/kafka';
import type {
  StartAssignment,
  TrackOrderStatus,
} from '../../../application/assignment.use-cases.js';
import { InvalidPayloadError } from './event-payloads.js';
import { OrderEventsConsumer } from './order-events.consumer.js';

const ORDER = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
const DESTINATION = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};

function event(
  eventType: string,
  payload: object,
  aggregateVersion: number | null = null,
) {
  return createEnvelope({
    eventType,
    schemaVersion: 1,
    producer: 'orders-service',
    correlationId: 'corr-1',
    aggregateId: ORDER,
    aggregateVersion,
    payload,
  });
}

function setup() {
  const kafka = { subscribe: vi.fn().mockResolvedValue(undefined) };
  const start = { execute: vi.fn().mockResolvedValue('ASSIGNED') };
  const status = { execute: vi.fn().mockResolvedValue('APPLIED') };
  const consumer = new OrderEventsConsumer(
    kafka as unknown as KafkaConsumerService,
    start as unknown as StartAssignment,
    status as unknown as TrackOrderStatus,
  );
  return { consumer, kafka, start, status };
}

describe('OrderEventsConsumer', () => {
  it('subscribes to orders.events only (with the service group)', async () => {
    const t = setup();
    await t.consumer.onApplicationBootstrap();

    expect(t.kafka.subscribe).toHaveBeenCalledTimes(1);
    expect(t.kafka.subscribe.mock.calls[0][0]).toMatchObject({
      topic: 'orders.events',
    });
    expect(t.kafka.subscribe.mock.calls[0][0].groupId).toBeUndefined(); // defaults to 'profiles-service'
  });

  it('OrderCreated starts the assignment with the destination and the correlation id', async () => {
    const t = setup();
    const envelope = event(
      'OrderCreated',
      {
        orderId: ORDER,
        customerId: '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10',
        status: 'CREATED',
        destination: DESTINATION,
      },
      1,
    );
    await t.consumer.onOrderEvent(envelope);

    expect(t.start.execute).toHaveBeenCalledWith({
      eventId: envelope.eventId,
      correlationId: 'corr-1',
      orderId: ORDER,
      customerId: '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10',
      destination: DESTINATION,
      version: 1,
    });
  });

  it('OrderCreated without a destination location is invalid (-> retries, then DLQ)', async () => {
    const t = setup();
    await expect(
      t.consumer.onOrderEvent(
        event(
          'OrderCreated',
          {
            orderId: ORDER,
            customerId: '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10',
            destination: { address: 'x' },
          },
          1,
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    expect(t.start.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['OrderOnTheWay', 'ON_THE_WAY'],
    ['OrderDelivered', 'DELIVERED'],
    ['OrderCancelled', 'CANCELLED'],
  ])(
    '%s is tracked as %s with its aggregateVersion and driver',
    async (eventType, status) => {
      const t = setup();
      const envelope = event(
        eventType,
        {
          orderId: ORDER,
          status,
          driverId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
        },
        3,
      );
      await t.consumer.onOrderEvent(envelope);

      expect(t.status.execute).toHaveBeenCalledWith({
        eventId: envelope.eventId,
        eventType,
        status,
        orderId: ORDER,
        version: 3,
        driverId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
        correlationId: 'corr-1',
      });
    },
  );

  it('ids that are not UUIDs are invalid', async () => {
    const t = setup();
    await expect(
      t.consumer.onOrderEvent(
        event(
          'OrderCreated',
          { orderId: 'o-1', customerId: 'c-1', destination: DESTINATION },
          1,
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('a status event without aggregateVersion is invalid', async () => {
    const t = setup();
    await expect(
      t.consumer.onOrderEvent(
        event('OrderDelivered', { orderId: ORDER }, null),
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('ignores other events on the topic', async () => {
    const t = setup();
    await t.consumer.onOrderEvent(event('SomethingElse', { orderId: ORDER }));

    expect(t.start.execute).not.toHaveBeenCalled();
    expect(t.status.execute).not.toHaveBeenCalled();
  });
});
