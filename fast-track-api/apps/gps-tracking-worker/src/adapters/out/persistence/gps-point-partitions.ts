/**
 * Keeps the monthly partitions of `gps_points` ready (ADR-011).
 *
 * PostgreSQL does not create range partitions by itself. This service creates
 * the partitions of the previous, current and next two months when the worker
 * starts (before the Kafka consumers subscribe) and once a day afterwards, so
 * a month always has its partition before its first point arrives.
 *
 * Retention: old partitions can be detached and archived by an operator
 * (`ALTER TABLE gps_points DETACH PARTITION gps_points_y2026m01`); no
 * automatic deletion, since the history is the audit trail.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface MonthlyPartition {
  /** e.g. `gps_points_y2026m10`. */
  name: string;
  /** Inclusive lower bound, ISO UTC. */
  from: string;
  /** Exclusive upper bound, ISO UTC. */
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The partitions of the months from `monthsBack` before `now` to `monthsAhead` after it. */
export function monthlyPartitions(now: Date, monthsBack = 1, monthsAhead = 2): MonthlyPartition[] {
  const partitions: MonthlyPartition[] = [];
  for (let offset = -monthsBack; offset <= monthsAhead; offset++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const month = String(start.getUTCMonth() + 1).padStart(2, '0');
    partitions.push({ name: `gps_points_y${start.getUTCFullYear()}m${month}`, from: start.toISOString(), to: end.toISOString() });
  }
  return partitions;
}

@Injectable()
export class GpsPointPartitions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GpsPointPartitions.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dataSource: DataSource) {}

  /** onModuleInit runs before any onApplicationBootstrap, i.e. before the consumers start. */
  async onModuleInit(): Promise<void> {
    await this.ensure();
    this.timer = setInterval(() => void this.ensure(), DAY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Creates the missing partitions; never throws (points fall back to the DEFAULT partition). */
  async ensure(now = new Date()): Promise<void> {
    for (const partition of monthlyPartitions(now)) {
      try {
        // Names and bounds come from monthlyPartitions(), never from input.
        await this.dataSource.query(
          `CREATE TABLE IF NOT EXISTS ${partition.name} PARTITION OF gps_points
             FOR VALUES FROM ('${partition.from}') TO ('${partition.to}')`,
        );
      } catch (error) {
        // Typically: the DEFAULT partition already holds rows of that month
        // (a device clock far ahead). Those points stay in DEFAULT, still queryable.
        this.logger.warn({
          msg: 'Could not create GPS history partition; its points stay in gps_points_default',
          partition: partition.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
