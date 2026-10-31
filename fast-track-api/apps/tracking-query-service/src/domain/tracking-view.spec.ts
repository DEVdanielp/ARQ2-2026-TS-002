import { canView, locationAgeSeconds, toTrackingView, type StoredTrackingView } from './tracking-view.js';

const NOW = new Date('2026-10-18T15:24:06Z');

function stored(overrides: Partial<StoredTrackingView> = {}): StoredTrackingView & { status: 'ON_THE_WAY' } {
  return {
    orderId: 'order-1',
    customerId: 'customer-1',
    version: 3,
    driverId: 'driver-1',
    driverName: 'Carlos Ruiz',
    assignmentStatus: 'ASSIGNED',
    destination: { address: 'Cra 43A #1-50, Medellín', location: { lat: 6.2088, lng: -75.5679 } },
    lastLocation: { lat: 6.2439, lng: -75.5807 },
    lastLocationDeviceTime: '2026-10-18T15:20:06Z',
    lastSequence: 1042,
    nearbyReached: false,
    lastRejectedIntent: null,
    updatedAt: '2026-10-18T15:20:07Z',
    revision: 7,
    ...overrides,
    status: 'ON_THE_WAY',
  };
}

describe('locationAgeSeconds', () => {
  it('counts whole seconds since the device time', () => {
    expect(locationAgeSeconds('2026-10-18T15:20:06Z', NOW)).toBe(240);
  });

  it('is null without a location', () => {
    expect(locationAgeSeconds(null, NOW)).toBeNull();
  });

  it('never goes negative when the device clock is ahead', () => {
    expect(locationAgeSeconds('2026-10-18T15:25:00Z', NOW)).toBe(0);
  });
});

describe('toTrackingView', () => {
  it('F3-S2: a location younger than 5 minutes keeps tracking available', () => {
    const view = toTrackingView(stored(), NOW);
    expect(view).toMatchObject({ locationAgeSeconds: 240, trackingAvailable: true, status: 'ON_THE_WAY' });
  });

  it('F3-S3: a location 5 minutes old or more makes tracking unavailable, status unchanged', () => {
    const view = toTrackingView(stored({ lastLocationDeviceTime: '2026-10-18T15:19:06Z' }), NOW);
    expect(view).toMatchObject({ locationAgeSeconds: 300, trackingAvailable: false, status: 'ON_THE_WAY' });
    expect(view.lastLocation).toEqual({ lat: 6.2439, lng: -75.5807 });
  });

  it('without any location tracking is not available', () => {
    const view = toTrackingView(stored({ lastLocation: null, lastLocationDeviceTime: null, lastSequence: null }), NOW);
    expect(view).toMatchObject({ locationAgeSeconds: null, trackingAvailable: false });
  });

  it('does not leak internal fields', () => {
    const view = toTrackingView(stored(), NOW) as unknown as Record<string, unknown>;
    expect(view.customerId).toBeUndefined();
    expect(view.revision).toBeUndefined();
  });
});

describe('canView', () => {
  const view = { customerId: 'customer-1' };

  it('lets the owner see the order', () => {
    expect(canView({ userId: 'customer-1', roles: ['CUSTOMER'] }, view)).toBe(true);
  });

  it("refuses another customer's order", () => {
    expect(canView({ userId: 'customer-2', roles: ['CUSTOMER'] }, view)).toBe(false);
  });

  it('lets operations see any order', () => {
    expect(canView({ userId: 'ops-1', roles: ['OPERATIONS'] }, view)).toBe(true);
  });

  it('refuses drivers', () => {
    expect(canView({ userId: 'customer-1', roles: ['DRIVER'] }, view)).toBe(false);
  });

  it('refuses a customer while the owner is still unknown', () => {
    expect(canView({ userId: 'customer-1', roles: ['CUSTOMER'] }, { customerId: null })).toBe(false);
  });
});
