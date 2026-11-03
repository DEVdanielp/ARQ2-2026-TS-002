/**
 * Kafka adapter tests: subscriptions, routing and payload checks, with the
 * real use cases over in-memory ports.
 */
import { randomUUID } from 'node:crypto';
import { createEnvelope, type EventEnvelope } from '@libs/events';
import type { KafkaConsumerService } from '@libs/kafka';
import { newOrder, type Order } from '../../../domain/order.js';
import {
  ApplyIntent,
  RecordDriverAssigned,
  RecordDriverUnassigned,
} from '../../../application/state-engine.use-cases.js';
import {
  FakeClock,
  InMemoryOrdersStore,
} from '../../../application/testing/in-memory.js';
import { InvalidPayloadError } from './event-payloads.js';
import { OrdersConsumer } from './orders.consumer.js';

const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';

function event(eventType: string, payload: unknown): EventEnvelope {
  return createEnvelope({
    eventType,
    schemaVersion: 1,
    producer: 'test',
    correlationId: randomUUID(),
    aggregateId: ORDER,
    aggregateVersion: null,
    payload,
  });
}

function setup() {
  const store = new InMemoryOrdersStore();
  const clock = new FakeClock();
  const subscribe = vi.fn().mockResolvedValue(undefined);
  const consumer = new OrdersConsumer(
    { subscribe } as unknown as KafkaConsumerService,
    new ApplyIntent(store, clock),
    new RecordDriverAssigned(store, clock),
    new RecordDriverUnassigned(store, clock),
  );
  const order: Order = {
    ...newOrder({
      orderId: ORDER,
      customerId: CUSTOMER,
      destination: {
        address: 'Cra 43A #1-50',
        location: { lat: 6.2088, lng: -75.5679 },
      },
      notes: null,
      now: clock.now(),
    }),
  };
  store.seed(order);
  return { store, consumer, subscribe };
}

const pickup = {
  intentId: randomUUID(),
  orderId: ORDER,
  type: 'PICKUP_CONFIRMED',
  actor: 'DRIVER',
  actorId: DRIVER,
  requestedAt: '2026-10-18T15:00:00Z',
};

describe('OrdersConsumer', () => {
  it('subscribes to its two topics with the service group', async () => {
    const t = setup();
    await t.consumer.onApplicationBootstrap();

    expect(t.subscribe.mock.calls.map(([options]) => options.topic)).toEqual([
      'orders.intents',
      'assignment.events',
    ]);
    expect(t.subscribe.mock.calls[0][0].groupId).toBeUndefined();
  });

  it('drives a whole order: assigned, then picked up', async () => {
    const t = setup();
    await t.consumer.onAssignmentEvent(
      event('DriverAssigned', { orderId: ORDER, driverId: DRIVER }),
    );
    await t.consumer.onIntent(event('PickupConfirmed', pickup));

    expect(await t.store.findOrder(ORDER)).toMatchObject({
      status: 'ON_THE_WAY',
      driverId: DRIVER,
      version: 3,
    });
  });

  it('clears the driver on DriverUnassigned', async () => {
    const t = setup();
    await t.consumer.onAssignmentEvent(
      event('DriverAssigned', { orderId: ORDER, driverId: DRIVER }),
    );
    await t.consumer.onAssignmentEvent(
      event('DriverUnassigned', { orderId: ORDER, driverId: DRIVER }),
    );

    expect((await t.store.findOrder(ORDER))?.driverId).toBeNull();
  });

  it('does not throw for an invalid transition: it is recorded, never retried', async () => {
    const t = setup();
    await expect(
      t.consumer.onIntent(event('PickupConfirmed', pickup)),
    ).resolves.toBeUndefined();

    expect(t.store.rejected).toHaveLength(1);
  });

  it('ignores AssignmentFailed: the order stays CREATED', async () => {
    const t = setup();
    await t.consumer.onAssignmentEvent(
      event('AssignmentFailed', { orderId: ORDER, attempts: 20 }),
    );

    expect(await t.store.findOrder(ORDER)).toMatchObject({
      status: 'CREATED',
      version: 1,
    });
  });

  it('throws for a payload it cannot trust, so it ends in the DLQ', async () => {
    const t = setup();
    await expect(
      t.consumer.onIntent(
        event('PickupConfirmed', { ...pickup, orderId: 'not-a-uuid' }),
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(
      t.consumer.onIntent(
        event('DeliveryConfirmed', { ...pickup, type: 'PICKUP_CONFIRMED' }),
      ),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(
      t.consumer.onIntent(event('PickupConfirmed', { ...pickup, actor: 'CAT' })),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(
      t.consumer.onAssignmentEvent(event('DriverAssigned', { orderId: ORDER })),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});
