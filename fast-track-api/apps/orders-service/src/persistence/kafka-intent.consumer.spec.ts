import { KafkaIntentConsumer } from './kafka-intent.consumer.js';
import type { IntentProcessor } from '../application/intent-processor.port.js';
import type { EventPublisher } from '../application/outbox-port.js';
import type { EachMessagePayload } from 'kafkajs';

const mocks = vi.hoisted(() => ({
  consumerConnect: vi.fn(),
  consumerSubscribe: vi.fn(),
  consumerRun: vi.fn(),
  consumerCommit: vi.fn(),
  consumerStop: vi.fn(),
  consumerDisconnect: vi.fn(),
  publisherPublish: vi.fn(),
  eachMessage: undefined as unknown,
  consumerFactory: vi.fn(),
}));

vi.mock('kafkajs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('kafkajs')>();
  return {
    ...actual,
    Kafka: class {
      consumer() {
        return mocks.consumerFactory();
      }
    },
  };
});

describe('KafkaIntentConsumer', () => {
  const previousDatabaseUrl = process.env.ORDERS_DATABASE_URL;
  const previousBrokers = process.env.KAFKA_BROKERS;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.eachMessage = undefined;
    process.env.ORDERS_DATABASE_URL = 'postgresql://test';
    process.env.KAFKA_BROKERS = 'kafka:9092';
    mocks.consumerConnect.mockResolvedValue(undefined);
    mocks.consumerSubscribe.mockResolvedValue(undefined);
    mocks.consumerRun.mockImplementation(async (options: { eachMessage: unknown }) => {
      mocks.eachMessage = options.eachMessage;
    });
    mocks.consumerCommit.mockResolvedValue(undefined);
    mocks.consumerStop.mockResolvedValue(undefined);
    mocks.consumerDisconnect.mockResolvedValue(undefined);
    mocks.publisherPublish.mockResolvedValue(undefined);
    mocks.consumerFactory.mockReturnValue({
      connect: mocks.consumerConnect,
      subscribe: mocks.consumerSubscribe,
      run: mocks.consumerRun,
      commitOffsets: mocks.consumerCommit,
      stop: mocks.consumerStop,
      disconnect: mocks.consumerDisconnect,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousDatabaseUrl === undefined) {
      delete process.env.ORDERS_DATABASE_URL;
    } else {
      process.env.ORDERS_DATABASE_URL = previousDatabaseUrl;
    }
    if (previousBrokers === undefined) {
      delete process.env.KAFKA_BROKERS;
    } else {
      process.env.KAFKA_BROKERS = previousBrokers;
    }
  });

  it('commits the source offset after a processed intent', async () => {
    const processIntent = vi.fn().mockResolvedValue({
      kind: 'applied',
      status: 'ON_THE_WAY',
      version: 2,
    });
    const processor: IntentProcessor = {
      process: processIntent,
    };
    const consumer = createConsumer(processor);
    await start(consumer);

    await messageHandler(0);

    expect(processIntent).toHaveBeenCalledOnce();
    expect(mocks.consumerCommit).toHaveBeenCalledWith([
      { topic: 'orders.intents', partition: 2, offset: '43' },
    ]);
    expect(mocks.publisherPublish).not.toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });

  it('commits a business rejection without publishing it outside the outbox', async () => {
    const processor: IntentProcessor = {
      process: vi.fn().mockResolvedValue({
        kind: 'rejected',
        reason: 'Driver is no longer assigned.',
        status: 'CREATED',
      }),
    };
    const consumer = createConsumer(processor);
    await start(consumer);

    await messageHandler(0);

    expect(mocks.consumerCommit).toHaveBeenCalledOnce();
    expect(mocks.publisherPublish).not.toHaveBeenCalled();
    await consumer.onModuleDestroy();
  });

  it('retries technical errors and publishes to the DLQ before committing', async () => {
    vi.useFakeTimers();
    const processIntent = vi
      .fn()
      .mockRejectedValue(new Error('database connection failed'));
    const processor: IntentProcessor = {
      process: processIntent,
    };
    const consumer = createConsumer(processor);
    await start(consumer);

    const handling = messageHandler(0);
    await vi.runAllTimersAsync();
    await handling;

    expect(processIntent).toHaveBeenCalledTimes(4);
    expect(mocks.publisherPublish).toHaveBeenCalledWith(
      'orders.intents.dlq',
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({
        eventType: 'DeadLetteredEvent',
        payload: expect.objectContaining({
          sourceTopic: 'orders.intents',
          sourceOffset: '42',
          error: 'database connection failed',
        }),
      }),
      expect.objectContaining({
        eventType: 'DeadLetteredEvent',
        sourceTopic: 'orders.intents',
      }),
    );
    expect(mocks.consumerCommit).toHaveBeenCalledWith([
      { topic: 'orders.intents', partition: 2, offset: '43' },
    ]);
    await consumer.onModuleDestroy();
  });

  function createConsumer(processor: IntentProcessor): KafkaIntentConsumer {
    const publisher: EventPublisher = {
      publish: mocks.publisherPublish,
    };
    return new KafkaIntentConsumer(processor, publisher);
  }

  async function start(consumer: KafkaIntentConsumer): Promise<void> {
    await consumer.onModuleInit();
    await vi.waitFor(() => {
      expect(mocks.eachMessage).toBeTypeOf('function');
    });
  }

  async function messageHandler(attempt: number): Promise<void> {
    const handler = mocks.eachMessage as
      | ((payload: EachMessagePayload) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error('Kafka consumer did not register its message handler.');
    }
    const eventId =
      attempt === 0
        ? '11111111-1111-4111-8111-111111111111'
        : '77777777-7777-4777-8777-777777777777';
    await handler({
      topic: 'orders.intents',
      partition: 2,
      message: {
        key: Buffer.from('22222222-2222-4222-8222-222222222222'),
        value: Buffer.from(
          JSON.stringify({
            eventId,
            eventType: 'PickupConfirmed',
            schemaVersion: 1,
            occurredAt: '2026-10-18T15:20:00.000Z',
            producer: 'orders-service',
            correlationId: '33333333-3333-4333-8333-333333333333',
            aggregateId: '22222222-2222-4222-8222-222222222222',
            aggregateVersion: null,
            payload: {},
          }),
        ),
        offset: '42',
        timestamp: '2026-10-18T15:20:00.000Z',
        attributes: 0,
        headers: {},
      },
      heartbeat: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    });
  }
});
