import { latestPoint, planBatch } from './batch-plan.js';

const point = (sequence: number, lat = 6.24) => ({ sequence, lat, lng: -75.58, deviceTime: '2026-10-18T15:20:00Z' });
const sequences = (points: { sequence: number }[]) => points.map((p) => p.sequence);

describe('planBatch', () => {
  it('sorts by sequence and moves the location to the highest one (F2-S3)', () => {
    const plan = planBatch([point(5), point(2), point(9), point(1)], null, new Set());

    expect(sequences(plan.toStore)).toEqual([1, 2, 5, 9]);
    expect(sequences(plan.advancing)).toEqual([1, 2, 5, 9]);
    expect(plan.newLocation?.sequence).toBe(9);
    expect(plan).toMatchObject({ duplicates: 0, late: 0 });
  });

  it('ignores sequences already stored and never moves backward (F2-S4)', () => {
    const plan = planBatch([point(10), point(11)], 11, new Set([10, 11]));

    expect(plan.toStore).toEqual([]);
    expect(plan.newLocation).toBeNull();
    expect(plan.duplicates).toBe(2);
  });

  it('stores late points without moving the location (ADR-018)', () => {
    const plan = planBatch([point(7), point(8), point(12)], 10, new Set());

    expect(sequences(plan.toStore)).toEqual([7, 8, 12]);
    expect(sequences(plan.advancing)).toEqual([12]);
    expect(plan.newLocation?.sequence).toBe(12);
    expect(plan.late).toBe(2);
  });

  it('a batch made only of late points stores them and keeps the location', () => {
    const plan = planBatch([point(3), point(4)], 10, new Set());

    expect(sequences(plan.toStore)).toEqual([3, 4]);
    expect(plan.newLocation).toBeNull();
  });

  it('keeps the first occurrence of a sequence repeated inside the batch', () => {
    const plan = planBatch([point(4, 1), point(4, 2), point(5)], null, new Set());

    expect(plan.toStore.map((p) => [p.sequence, p.lat])).toEqual([
      [4, 1],
      [5, 6.24],
    ]);
    expect(plan.duplicates).toBe(1);
  });

  it('accepts sequence 0 as the first point', () => {
    expect(planBatch([point(0)], null, new Set()).newLocation?.sequence).toBe(0);
  });

  it('does not mutate the input', () => {
    const points = [point(2), point(1)];
    planBatch(points, null, new Set());
    expect(sequences(points)).toEqual([2, 1]);
  });
});

describe('latestPoint', () => {
  it('returns the point with the highest sequence, or null', () => {
    expect(latestPoint([point(3), point(9), point(4)])?.sequence).toBe(9);
    expect(latestPoint([])).toBeNull();
  });
});
