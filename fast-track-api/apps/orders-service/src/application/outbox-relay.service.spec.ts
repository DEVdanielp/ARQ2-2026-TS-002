import { OutboxRelayService } from './outbox-relay.service.js';
import type {
  EventEnvelope,
  EventPublisher,
  OutboxEvent,
  OutboxRepository,
} from './outbox-port.js';

describe('OutboxRelayService', () => {
  const event: OutboxEvent = {
    eventId: '11111111-1111-4111-8111-111111111111',
    topic: 'orders.events',
    aggregateId: '22222222-2222-4222-8222-222222222222',
    eventType: 'OrderCreated',
    schemaVersion: 1,
    occurredAt: new Date('2026-10-18T15:01:00Z'),
    producer: 'orders-service',
    correlationId: '33333333-3333-4333-8333-333333333333',
    aggregateVersion: 1,
    payload: { orderId: '22222222-2222-4222-8222-222222222222' },
    headers: {},
    attempts: 0,
  };
  const claimPending = vi.fn();
  const markPublished = vi.fn();
  const markFailed = vi.fn();
  const publish = vi.fn();
  const repository: OutboxRepository = {
    claimPending,
    markPublished,
    markFailed,
  };
  const publisher: EventPublisher = { publish };
  const service = new OutboxRelayService(repository, publisher);

  beforeEach(() => {
    vi.clearAllMocks();
    claimPending.mockResolvedValue([event]);
    markPublished.mockResolvedValue(undefined);
    markFailed.mockResolvedValue(undefined);
    publish.mockResolvedValue(undefined);
  });

  it('publishes the full event envelope with the aggregate key and headers', async () => {
    await service.poll();

    expect(claimPending).toHaveBeenCalledWith(
      20,
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
    expect(publish).toHaveBeenCalledWith(
      'orders.events',
      event.aggregateId,
      {
        eventId: event.eventId,
        eventType: event.eventType,
        schemaVersion: 1,
        occurredAt: '2026-10-18T15:01:00.000Z',
        producer: 'orders-service',
        correlationId: event.correlationId,
        aggregateId: event.aggregateId,
        aggregateVersion: 1,
        payload: event.payload,
      } satisfies EventEnvelope,
      {
        eventType: 'OrderCreated',
        correlationId: event.correlationId,
      },
    );
    expect(markPublished).toHaveBeenCalledWith(
      event.eventId,
      expect.any(String),
    );
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('records a failed delivery for retry instead of marking it published', async () => {
    publish.mockRejectedValue(new Error('Kafka unavailable'));

    await service.poll();

    expect(markFailed).toHaveBeenCalledWith(
      event.eventId,
      expect.any(String),
      'Kafka unavailable',
    );
    expect(markPublished).not.toHaveBeenCalled();
  });

  it('does not overlap concurrent polls', async () => {
    let finishClaim: ((events: OutboxEvent[]) => void) | undefined;
    claimPending.mockReturnValueOnce(
      new Promise<OutboxEvent[]>((resolve) => {
        finishClaim = resolve;
      }),
    );

    const firstPoll = service.poll();
    await service.poll();
    expect(claimPending).toHaveBeenCalledTimes(1);

    finishClaim?.([]);
    await firstPoll;
  });
});
