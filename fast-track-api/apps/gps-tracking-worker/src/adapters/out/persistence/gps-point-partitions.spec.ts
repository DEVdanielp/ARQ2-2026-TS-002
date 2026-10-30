import type { DataSource } from 'typeorm';
import { GpsPointPartitions, monthlyPartitions } from './gps-point-partitions.js';

describe('monthlyPartitions', () => {
  it('covers the previous, current and next two months, in UTC', () => {
    expect(monthlyPartitions(new Date('2026-10-29T21:00:00Z'))).toEqual([
      { name: 'gps_points_y2026m09', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      { name: 'gps_points_y2026m10', from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
      { name: 'gps_points_y2026m11', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
      { name: 'gps_points_y2026m12', from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' },
    ]);
  });

  it('crosses year boundaries', () => {
    expect(monthlyPartitions(new Date('2027-01-15T00:00:00Z')).map((p) => p.name)).toEqual([
      'gps_points_y2026m12',
      'gps_points_y2027m01',
      'gps_points_y2027m02',
      'gps_points_y2027m03',
    ]);
  });
});

describe('GpsPointPartitions', () => {
  it('keeps going when one partition cannot be created', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('default partition holds rows')).mockResolvedValue([]);
    const partitions = new GpsPointPartitions({ query } as unknown as DataSource);

    await expect(partitions.ensure(new Date('2026-10-29T00:00:00Z'))).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1][0]).toContain('CREATE TABLE IF NOT EXISTS gps_points_y2026m10 PARTITION OF gps_points');
  });
});
