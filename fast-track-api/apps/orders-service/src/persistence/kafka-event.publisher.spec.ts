import { KafkaEventPublisher } from './kafka-event.publisher.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  createProducer: vi.fn(),
}));

vi.mock('kafkajs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('kafkajs')>();
  return {
    ...actual,
    Kafka: class {
      producer(options: unknown) {
        return mocks.createProducer(options);
      }
    },
  };
});

describe('KafkaEventPublisher', () => {
  const previousBrokers = process.env.KAFKA_BROKERS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KAFKA_BROKERS = 'kafka:9092, kafka-backup:9092';
    mocks.createProducer.mockReturnValue({
      connect: mocks.connect,
      disconnect: mocks.disconnect,
      send: mocks.send,
    });
    mocks.connect.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue([]);
    mocks.disconnect.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (previousBrokers === undefined) {
      delete process.env.KAFKA_BROKERS;
    } else {
      process.env.KAFKA_BROKERS = previousBrokers;
    }
  });

  it('publishes the JSON event under its aggregate key and Kafka headers', async () => {
    const publisher = new KafkaEventPublisher();
    const event = {
      eventId: '11111111-1111-4111-8111-111111111111',
      eventType: 'OrderCreated',
      schemaVersion: 1,
      occurredAt: '2026-10-18T15:01:00.000Z',
      producer: 'orders-service',
      correlationId: '33333333-3333-4333-8333-333333333333',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      aggregateVersion: 1,
      payload: { orderId: '22222222-2222-4222-8222-222222222222' },
    };

    await publisher.publish('orders.events', event.aggregateId, event, {
      eventType: event.eventType,
      correlationId: event.correlationId,
    });

    expect(mocks.createProducer).toHaveBeenCalledWith({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith({
      topic: 'orders.events',
      acks: -1,
      messages: [
        {
          key: event.aggregateId,
          value: JSON.stringify(event),
          headers: {
            eventType: Buffer.from('OrderCreated'),
            correlationId: Buffer.from(event.correlationId),
          },
        },
      ],
    });
  });

  it('rejects publishing when no Kafka broker is configured', async () => {
    delete process.env.KAFKA_BROKERS;
    const publisher = new KafkaEventPublisher();

    await expect(
      publisher.publish(
        'orders.events',
        '22222222-2222-4222-8222-222222222222',
        {
          eventId: '11111111-1111-4111-8111-111111111111',
          eventType: 'OrderCreated',
          schemaVersion: 1,
          occurredAt: '2026-10-18T15:01:00.000Z',
          producer: 'orders-service',
          correlationId: '33333333-3333-4333-8333-333333333333',
          aggregateId: '22222222-2222-4222-8222-222222222222',
          aggregateVersion: 1,
          payload: {},
        },
        {},
      ),
    ).rejects.toThrow('KAFKA_BROKERS is not configured.');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
