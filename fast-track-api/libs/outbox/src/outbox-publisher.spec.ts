import { createEnvelope } from '@libs/events';
import { publishOutboxBatch, type OutboxStore, type PendingOutboxRow } from './outbox-publisher.js';
import { OutboxService } from './outbox.service.js';
import type { EntityManager } from 'typeorm';

const envelope = createEnvelope({
  eventType: 'NotificationRetry',
  schemaVersion: 1,
  producer: 'notification-service',
  correlationId: 'c1',
  aggregateId: 'order-1',
  payload: {},
});

function row(id: string): PendingOutboxRow {
  return { id, topic: 'notifications.retry', messageKey: 'order-1', envelope };
}

function fakeStore(rows: PendingOutboxRow[]) {
  const published: string[] = [];
  const failed: Array<[string, string]> = [];
  const store: OutboxStore = {
    claimDue: async (limit) => rows.slice(0, limit),
    markPublished: async (id) => void published.push(id),
    markFailed: async (id, error) => void failed.push([id, error]),
  };
  return { store, published, failed };
}

describe('publishOutboxBatch', () => {
  it('publishes due rows in order and marks each one', async () => {
    const { store, published } = fakeStore([row('1'), row('2')]);
    const producer = { publish: vi.fn().mockResolvedValue({}) };

    const result = await publishOutboxBatch(store, producer, 10);

    expect(result).toEqual({ published: 2, failed: false });
    expect(published).toEqual(['1', '2']);
    expect(producer.publish).toHaveBeenNthCalledWith(1, 'notifications.retry', 'order-1', envelope);
  });

  it('stops at the first failure so later rows do not overtake it', async () => {
    const { store, published, failed } = fakeStore([row('1'), row('2'), row('3')]);
    const producer = {
      publish: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('broker down')),
    };

    const result = await publishOutboxBatch(store, producer, 10);

    expect(result).toEqual({ published: 1, failed: true });
    expect(published).toEqual(['1']);
    expect(failed).toEqual([['2', 'broker down']]);
    expect(producer.publish).toHaveBeenCalledTimes(2);
  });
});

describe('OutboxService', () => {
  it('inserts the message with the caller transaction', async () => {
    const manager = { query: vi.fn().mockResolvedValue([]) } as unknown as EntityManager;
    const publishAfter = new Date('2026-10-30T00:01:00Z');

    await new OutboxService().enqueue(manager, {
      topic: 'notifications.retry',
      key: 'order-1',
      envelope,
      publishAfter,
    });

    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox'), [
      'notifications.retry',
      'order-1',
      JSON.stringify(envelope),
      publishAfter,
    ]);
  });

  it('refuses a message without key', async () => {
    const manager = { query: vi.fn() } as unknown as EntityManager;

    await expect(
      new OutboxService().enqueue(manager, { topic: 'notifications.retry', key: '', envelope }),
    ).rejects.toThrow(/no key/);
  });
});
