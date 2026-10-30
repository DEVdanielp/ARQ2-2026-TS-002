import { detectProximity, distanceMeters } from './proximity.js';

const DESTINATION = { lat: 6.2088, lng: -75.5679 };
const THRESHOLDS = { distanceMeters: 500, etaSeconds: 300 };
// ~0.0009 degrees of latitude is ~100 m.
const at = (sequence: number, metersNorth: number) => ({
  sequence,
  lat: DESTINATION.lat + metersNorth / 111_195,
  lng: DESTINATION.lng,
  deviceTime: '2026-10-18T15:40:00Z',
});

describe('distanceMeters', () => {
  it('is 0 for the same point', () => {
    expect(distanceMeters(DESTINATION, DESTINATION)).toBe(0);
  });

  it('matches a known distance (1 degree of latitude ~ 111.2 km)', () => {
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
  });

  it('measures ~430 m like the spec example', () => {
    expect(distanceMeters(at(1, 430), DESTINATION)).toBeCloseTo(430, 0);
  });
});

describe('detectProximity', () => {
  it('fires DISTANCE under 500 m', () => {
    const detection = detectProximity(DESTINATION, [at(1, 430)], THRESHOLDS, null);
    expect(detection).toMatchObject({ trigger: 'DISTANCE', etaSeconds: null });
    expect(detection?.distanceMeters).toBeCloseTo(430, 0);
  });

  it('does not fire at exactly 500 m or farther', () => {
    expect(detectProximity(DESTINATION, [at(1, 500.5), at(2, 2_000)], THRESHOLDS, null)).toBeNull();
  });

  it('returns the FIRST point in sequence order that is near', () => {
    const detection = detectProximity(DESTINATION, [at(1, 900), at(2, 400), at(3, 100)], THRESHOLDS, null);
    expect(detection?.point.sequence).toBe(2);
  });

  it('fires when a point in the middle of the batch was near, even if the last one is not', () => {
    const detection = detectProximity(DESTINATION, [at(1, 450), at(2, 800)], THRESHOLDS, null);
    expect(detection?.point.sequence).toBe(1);
  });

  it('fires ETA when the ETA of the last point is under 300 s', () => {
    const detection = detectProximity(DESTINATION, [at(1, 1_500)], THRESHOLDS, 260);
    expect(detection).toMatchObject({ trigger: 'ETA', etaSeconds: 260 });
  });

  it('does not fire ETA at 300 s or without an ETA', () => {
    expect(detectProximity(DESTINATION, [at(1, 1_500)], THRESHOLDS, 300)).toBeNull();
    expect(detectProximity(DESTINATION, [at(1, 1_500)], THRESHOLDS, null)).toBeNull();
  });

  it('prefers DISTANCE and reports the ETA when the near point is the last one', () => {
    expect(detectProximity(DESTINATION, [at(1, 100)], THRESHOLDS, 90)).toMatchObject({ trigger: 'DISTANCE', etaSeconds: 90 });
  });

  it('returns null for no points', () => {
    expect(detectProximity(DESTINATION, [], THRESHOLDS, 10)).toBeNull();
  });
});
