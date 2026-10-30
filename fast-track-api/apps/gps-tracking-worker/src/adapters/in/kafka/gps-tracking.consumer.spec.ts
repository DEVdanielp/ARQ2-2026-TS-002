import { createEnvelope } from '@libs/events';
import type { KafkaConsumerService } from '@libs/kafka';
import type { ProcessGpsBatch } from '../../../application/process-gps-batch.js';
import type { AssignRouteOrder, TrackOrderStatus, UnassignRouteOrder } from '../../../application/route-orders.use-cases.js';
import { InvalidPayloadError } from './event-payloads.js';
import { GpsTrackingConsumer } from './gps-tracking.consumer.js';

const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const ORDER = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
const BATCH = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';

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
  const process = { execute: vi.fn().mockResolvedValue({ stored: 1 }) };
  const track = { execute: vi.fn().mockResolvedValue(true) };
  const assign = { execute: vi.fn().mockResolvedValue('ASSIGNED') };
  const unassign = { execute: vi.fn().mockResolvedValue('UNASSIGNED') };
  const consumer = new GpsTrackingConsumer(
    kafka as unknown as KafkaConsumerService,
    process as unknown as ProcessGpsBatch,
    track as unknown as TrackOrderStatus,
    assign as unknown as AssignRouteOrder,
    unassign as unknown as UnassignRouteOrder,
  );
  return { consumer, kafka, process, track, assign, unassign };
}

describe('GpsTrackingConsumer', () => {
  it('subscribes once per topic, in the gps-tracking-worker group (default)', async () => {
    const t = setup();
    await t.consumer.onApplicationBootstrap();

    expect(t.kafka.subscribe.mock.calls.map(([options]) => [options.topic, options.groupId])).toEqual([
      ['gps.batches', undefined],
      ['assignment.events', undefined],
      ['orders.events', undefined],
    ]);
  });

  it('GpsBatchReceived runs ProcessGpsBatch with the parsed payload and correlation id', async () => {
    const t = setup();
    const payload = {
      driverId: DRIVER,
      batchId: BATCH,
      receivedAt: '2026-10-18T15:20:07Z',
      points: [{ lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T10:20:01-05:00', sequence: 1041, accuracyMeters: 8 }],
    };

    await t.consumer.onGpsBatch(event('GpsBatchReceived', payload));

    expect(t.process.execute).toHaveBeenCalledWith({
      payload: {
        ...payload,
        points: [{ lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T15:20:01.000Z', sequence: 1041, accuracyMeters: 8 }],
      },
      correlationId: 'corr-1',
    });
  });

  it('an invalid GPS payload throws (retried, then gps.batches.dlq) and touches nothing', async () => {
    const t = setup();

    await expect(t.consumer.onGpsBatch(event('GpsBatchReceived', { driverId: DRIVER, points: [] }))).rejects.toThrow(
      InvalidPayloadError,
    );
    expect(t.process.execute).not.toHaveBeenCalled();
  });

  it('DriverAssigned and DriverUnassigned go to their use cases with the eventId', async () => {
    const t = setup();
    const assigned = event('DriverAssigned', {
      orderId: ORDER,
      driverId: DRIVER,
      driverName: 'Carlos Ruiz',
      destination: { location: { lat: 6.2088, lng: -75.5679 } },
      assignedAt: '2026-10-18T15:01:10Z',
    });
    const unassigned = event('DriverUnassigned', { orderId: ORDER, driverId: DRIVER, reason: 'DRIVER_OFFLINE' });

    await t.consumer.onAssignmentEvent(assigned);
    await t.consumer.onAssignmentEvent(unassigned);

    expect(t.assign.execute).toHaveBeenCalledWith(
      assigned.eventId,
      { orderId: ORDER, driverId: DRIVER, destination: { lat: 6.2088, lng: -75.5679 } },
      'corr-1',
    );
    expect(t.unassign.execute).toHaveBeenCalledWith(unassigned.eventId, { orderId: ORDER, driverId: DRIVER }, 'corr-1');
  });

  it.each([
    ['OrderOnTheWay', 'ON_THE_WAY'],
    ['OrderDelivered', 'DELIVERED'],
    ['OrderCancelled', 'CANCELLED'],
  ])('%s tracks status %s with its aggregateVersion', async (eventType, status) => {
    const t = setup();

    await t.consumer.onOrderEvent(event(eventType, { orderId: ORDER, driverId: DRIVER, status }, 4));

    expect(t.track.execute).toHaveBeenCalledWith({ orderId: ORDER, status, version: 4, driverId: DRIVER }, 'corr-1');
  });

  it('an order status event without aggregateVersion is invalid', async () => {
    const t = setup();
    await expect(t.consumer.onOrderEvent(event('OrderDelivered', { orderId: ORDER }, null))).rejects.toThrow(/aggregateVersion/);
  });

  it('ignores events it does not need', async () => {
    const t = setup();

    await t.consumer.onOrderEvent(event('OrderCreated', { orderId: ORDER }, 1));
    await t.consumer.onAssignmentEvent(event('AssignmentFailed', { orderId: ORDER }));
    await t.consumer.onGpsBatch(event('SomethingElse', {}));

    expect(t.track.execute).not.toHaveBeenCalled();
    expect(t.assign.execute).not.toHaveBeenCalled();
    expect(t.process.execute).not.toHaveBeenCalled();
  });
});
