import { createEnvelope } from '@libs/events';
import type { KafkaConsumerService } from '@libs/kafka';
import type { AlertOperations } from '../../../application/alert-operations.js';
import type { NotifyCustomer } from '../../../application/notify-customer.js';
import type { RecordOrderRecipient, ReplicateCustomerContact } from '../../../application/replication.use-cases.js';
import type { RetryNotification } from '../../../application/retry-notification.js';
import { InvalidPayloadError } from './event-payloads.js';
import { NotificationEventsConsumer } from './notification-events.consumer.js';

const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';

function event(eventType: string, payload: object, aggregateVersion: number | null = null) {
  return createEnvelope({
    eventType,
    schemaVersion: 1,
    producer: 'test',
    correlationId: 'corr-1',
    aggregateId: ORDER,
    aggregateVersion,
    payload,
  });
}

function setup() {
  const kafka = { subscribe: vi.fn().mockResolvedValue(undefined) };
  const record = { execute: vi.fn().mockResolvedValue(undefined) };
  const replicate = { execute: vi.fn().mockResolvedValue(true) };
  const notify = { execute: vi.fn().mockResolvedValue({ channels: {} }) };
  const retry = { execute: vi.fn().mockResolvedValue('SENT') };
  const alert = { execute: vi.fn().mockResolvedValue(true) };
  const consumer = new NotificationEventsConsumer(
    kafka as unknown as KafkaConsumerService,
    record as unknown as RecordOrderRecipient,
    replicate as unknown as ReplicateCustomerContact,
    notify as unknown as NotifyCustomer,
    retry as unknown as RetryNotification,
    alert as unknown as AlertOperations,
  );
  return { consumer, kafka, record, replicate, notify, retry, alert };
}

describe('NotificationEventsConsumer', () => {
  it('subscribes once per topic', async () => {
    const t = setup();
    await t.consumer.onApplicationBootstrap();

    expect(t.kafka.subscribe.mock.calls.map(([options]) => options.topic)).toEqual([
      'orders.events',
      'tracking.proximity',
      'assignment.events',
      'profile.events',
      'notifications.retry',
    ]);
  });

  it('OrderCreated records the recipient, then offers the opt-in notification', async () => {
    const t = setup();
    await t.consumer.onOrderEvent(event('OrderCreated', { orderId: ORDER, customerId: 'c-1', status: 'CREATED' }));

    expect(t.record.execute).toHaveBeenCalledWith(ORDER, 'c-1');
    expect(t.notify.execute).toHaveBeenCalledWith({ orderId: ORDER, type: 'ORDER_CREATED', correlationId: 'corr-1' });
  });

  it.each([
    ['OrderOnTheWay', 'ON_THE_WAY'],
    ['OrderDelivered', 'DELIVERED'],
    ['OrderCancelled', 'CANCELLED'],
  ])('%s notifies %s', async (eventType, type) => {
    const t = setup();
    await t.consumer.onOrderEvent(event(eventType, { orderId: ORDER }));

    expect(t.notify.execute).toHaveBeenCalledWith({ orderId: ORDER, type, correlationId: 'corr-1' });
  });

  it('DriverNearDestination notifies NEARBY', async () => {
    const t = setup();
    await t.consumer.onProximityEvent(event('DriverNearDestination', { orderId: ORDER, trigger: 'DISTANCE' }));

    expect(t.notify.execute).toHaveBeenCalledWith({ orderId: ORDER, type: 'NEARBY', correlationId: 'corr-1' });
  });

  it('CustomerContactUpdated replicates the contact with its version', async () => {
    const t = setup();
    await t.consumer.onProfileEvent(
      event('CustomerContactUpdated', { customerId: 'c-1', name: 'Laura', email: 'l@example.com' }, 4),
    );

    expect(t.replicate.execute).toHaveBeenCalledWith(
      { customerId: 'c-1', name: 'Laura', email: 'l@example.com', phone: null },
      4,
    );
  });

  it('AssignmentFailed alerts operations; DriverAssigned is ignored', async () => {
    const t = setup();
    await t.consumer.onAssignmentEvent(event('DriverAssigned', { orderId: ORDER }));
    await t.consumer.onAssignmentEvent(event('AssignmentFailed', { orderId: ORDER, attempts: 20 }));

    expect(t.alert.execute).toHaveBeenCalledTimes(1);
    expect(t.alert.execute.mock.calls[0][0].payload).toMatchObject({ orderId: ORDER, attempts: 20 });
  });

  it('NotificationRetry is handed to the retry use case', async () => {
    const t = setup();
    await t.consumer.onRetryEvent(
      event('NotificationRetry', { orderId: ORDER, customerId: 'c-1', type: 'NEARBY', channel: 'PUSH', attempt: 1 }),
    );

    expect(t.retry.execute.mock.calls[0][0].payload).toMatchObject({ type: 'NEARBY', channel: 'PUSH', attempt: 1 });
  });

  it('throws on a payload without the fields we need (ends in the DLQ)', async () => {
    const t = setup();

    await expect(t.consumer.onOrderEvent(event('OrderDelivered', { status: 'DELIVERED' }))).rejects.toThrow(
      InvalidPayloadError,
    );
  });
});
