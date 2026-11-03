import { createEnvelope, type EventEnvelope } from '@libs/events';
import { InvalidPayloadError, toViewChange } from './event-payloads.js';

const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';

function envelope(eventType: string, payload: unknown, aggregateVersion: number | null = null): EventEnvelope {
  return createEnvelope({
    eventType,
    schemaVersion: 1,
    producer: 'test',
    correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
    aggregateId: ORDER,
    aggregateVersion,
    payload,
  });
}

const DESTINATION = { address: 'Cra 43A #1-50, Medellín', location: { lat: 6.2088, lng: -75.5679 } };

describe('toViewChange', () => {
  it('OrderCreated -> status CREATED v1 with the owner and destination', () => {
    const change = toViewChange(
      envelope('OrderCreated', { orderId: ORDER, customerId: CUSTOMER, status: 'CREATED', destination: DESTINATION }, 1),
    );
    expect(change).toEqual({
      kind: 'status',
      orderId: ORDER,
      status: 'CREATED',
      version: 1,
      customerId: CUSTOMER,
      destination: DESTINATION,
    });
  });

  it('OrderDelivered -> status DELIVERED with the envelope version', () => {
    const change = toViewChange(envelope('OrderDelivered', { orderId: ORDER, status: 'DELIVERED', driverId: DRIVER }, 4));
    expect(change).toEqual({ kind: 'status', orderId: ORDER, status: 'DELIVERED', version: 4, driverId: DRIVER });
  });

  it('a transition without aggregateVersion is invalid (it could regress the view)', () => {
    expect(() => toViewChange(envelope('OrderOnTheWay', { orderId: ORDER }))).toThrow(InvalidPayloadError);
  });

  it('DriverAssigned -> assigned, timed by assignedAt', () => {
    const change = toViewChange(
      envelope('DriverAssigned', {
        orderId: ORDER,
        driverId: DRIVER,
        driverName: 'Carlos Ruiz',
        destination: { location: DESTINATION.location },
        assignedAt: '2026-10-18T15:01:10Z',
      }),
    );
    expect(change).toEqual({
      kind: 'assigned',
      orderId: ORDER,
      driverId: DRIVER,
      driverName: 'Carlos Ruiz',
      destination: { location: DESTINATION.location },
      at: Date.parse('2026-10-18T15:01:10Z'),
    });
  });

  it('DriverUnassigned and AssignmentFailed fall back to occurredAt', () => {
    const unassigned = envelope('DriverUnassigned', { orderId: ORDER, driverId: DRIVER, reason: 'DRIVER_OFFLINE' });
    expect(toViewChange(unassigned)).toMatchObject({ kind: 'unassigned', at: Date.parse(unassigned.occurredAt) });
    expect(toViewChange(envelope('AssignmentFailed', { orderId: ORDER, failedAt: '2026-10-18T15:11:00Z' }))).toEqual({
      kind: 'failed',
      orderId: ORDER,
      at: Date.parse('2026-10-18T15:11:00Z'),
    });
  });

  it('LocationUpdated -> location', () => {
    const change = toViewChange(
      envelope('LocationUpdated', {
        orderId: ORDER,
        driverId: DRIVER,
        location: { lat: 6.2439, lng: -75.5807 },
        deviceTime: '2026-10-18T15:20:06Z',
        sequence: 1042,
      }),
    );
    expect(change).toEqual({
      kind: 'location',
      orderId: ORDER,
      driverId: DRIVER,
      location: { lat: 6.2439, lng: -75.5807 },
      deviceTime: '2026-10-18T15:20:06Z',
      sequence: 1042,
    });
  });

  it.each([
    ['sequence', { sequence: -1 }],
    ['location', { location: { lat: 91, lng: 0 } }],
    ['deviceTime', { deviceTime: 'not a date' }],
  ])('LocationUpdated with an invalid %s is rejected', (_field, override) => {
    const payload = {
      orderId: ORDER,
      driverId: DRIVER,
      location: { lat: 6.2, lng: -75.5 },
      deviceTime: '2026-10-18T15:20:06Z',
      sequence: 1,
      ...override,
    };
    expect(() => toViewChange(envelope('LocationUpdated', payload))).toThrow(InvalidPayloadError);
  });

  it('DriverNearDestination -> nearby', () => {
    expect(toViewChange(envelope('DriverNearDestination', { orderId: ORDER, trigger: 'DISTANCE' }))).toEqual({
      kind: 'nearby',
      orderId: ORDER,
    });
  });

  it('ignores events it does not use', () => {
    expect(toViewChange(envelope('CustomerContactUpdated', { customerId: CUSTOMER }))).toBeNull();
  });

  it('rejects a payload without orderId', () => {
    expect(() => toViewChange(envelope('DriverNearDestination', {}))).toThrow(InvalidPayloadError);
  });
});
