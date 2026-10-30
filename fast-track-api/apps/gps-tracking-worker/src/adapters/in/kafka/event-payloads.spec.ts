import { InvalidPayloadError, parseDriverAssigned, parseGpsBatchReceived, parseOrderStatusEvent } from './event-payloads.js';

const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const BATCH = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const ORDER = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';

const batch = (points: unknown[], overrides: object = {}) => ({
  driverId: DRIVER,
  batchId: BATCH,
  receivedAt: '2026-10-18T15:20:07Z',
  points,
  ...overrides,
});
const point = (overrides: object = {}) => ({ lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T15:20:01Z', sequence: 1, ...overrides });

describe('parseGpsBatchReceived', () => {
  it('accepts the spec example and drops absent optional fields', () => {
    expect(parseGpsBatchReceived(batch([point({ speedKmh: null })])).points).toEqual([
      { lat: 6.24, lng: -75.58, deviceTime: '2026-10-18T15:20:01.000Z', sequence: 1 },
    ]);
  });

  it.each([
    ['a non-UUID driver', batch([point()], { driverId: 'driver-1' }), 'driverId'],
    ['no points', batch([]), 'points'],
    ['latitude out of range', batch([point({ lat: 95 })]), 'lat'],
    ['a negative sequence', batch([point({ sequence: -3 })]), 'points.0.sequence'],
    ['a fractional sequence', batch([point({ sequence: 1.5 })]), 'points.0.sequence'],
    ['an unreadable device time', batch([point({ deviceTime: 'yesterday' })]), 'deviceTime'],
    ['a negative accuracy', batch([point({ accuracyMeters: -1 })]), 'accuracyMeters'],
  ])('rejects %s', (_name, payload, field) => {
    expect(() => parseGpsBatchReceived(payload)).toThrow(new InvalidPayloadError('GpsBatchReceived', field));
  });
});

describe('parseDriverAssigned', () => {
  it('reads the destination location', () => {
    expect(
      parseDriverAssigned({ orderId: ORDER, driverId: DRIVER, destination: { location: { lat: 6.2088, lng: -75.5679 } } }),
    ).toEqual({ orderId: ORDER, driverId: DRIVER, destination: { lat: 6.2088, lng: -75.5679 } });
  });

  it('rejects an assignment without destination', () => {
    expect(() => parseDriverAssigned({ orderId: ORDER, driverId: DRIVER })).toThrow(/destination/);
  });
});

describe('parseOrderStatusEvent', () => {
  it('keeps a missing or invalid driverId as null', () => {
    expect(parseOrderStatusEvent('OrderCancelled', { orderId: ORDER, driverId: null }, 2)).toEqual({
      orderId: ORDER,
      version: 2,
      driverId: null,
    });
  });
});
