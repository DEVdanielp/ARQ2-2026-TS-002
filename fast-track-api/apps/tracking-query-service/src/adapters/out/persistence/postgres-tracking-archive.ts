/**
 * TrackingArchive over PostgreSQL (query-archive-db).
 *
 * Plain SQL, as in the GPS Tracking Worker: idempotency lives in the
 * statements (`ON CONFLICT`, `WHERE revision < ...`), not in "check then
 * write" code, so concurrent instances cannot both pass a check.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { StoredTrackingView } from '../../../domain/tracking-view.js';
import { TrackingArchive, type ArchivedRoutePoint, type OrderRoute, type TimeRange } from '../../../application/ports.js';

interface RoutePointRow {
  driver_id: string;
  lat: number;
  lng: number;
  device_time: Date;
  sequence: string;
}

@Injectable()
export class PostgresTrackingArchive extends TrackingArchive {
  constructor(private readonly db: DataSource) {
    super();
  }

  async saveSnapshot(view: StoredTrackingView): Promise<void> {
    await this.db.query(
      `INSERT INTO order_snapshots (order_id, customer_id, status, version, revision, view, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (order_id) DO UPDATE
          SET customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, version = EXCLUDED.version,
              revision = EXCLUDED.revision, view = EXCLUDED.view, updated_at = now()
        WHERE order_snapshots.revision < EXCLUDED.revision`,
      [view.orderId, view.customerId, view.status, view.version, view.revision, JSON.stringify(view)],
    );
  }

  async findSnapshot(orderId: string): Promise<StoredTrackingView | null> {
    const rows: Array<{ view: StoredTrackingView }> = await this.db.query(
      `SELECT view FROM order_snapshots WHERE order_id = $1`,
      [orderId],
    );
    return rows[0]?.view ?? null;
  }

  async appendRoutePoint(point: ArchivedRoutePoint): Promise<void> {
    await this.db.query(
      `INSERT INTO route_points (order_id, sequence, driver_id, lat, lng, device_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id, sequence) DO NOTHING`,
      [point.orderId, point.sequence, point.driverId, point.location.lat, point.location.lng, point.deviceTime],
    );
  }

  async findRoute(orderId: string, range: TimeRange): Promise<OrderRoute | null> {
    const points: RoutePointRow[] = await this.db.query(
      `SELECT driver_id, lat, lng, device_time, sequence
         FROM route_points
        WHERE order_id = $1
          AND ($2::timestamptz IS NULL OR device_time >= $2)
          AND ($3::timestamptz IS NULL OR device_time <= $3)
        ORDER BY sequence`,
      [orderId, range.from ?? null, range.to ?? null],
    );

    let driverId = points.at(-1)?.driver_id ?? null;
    if (points.length === 0 || driverId === null) {
      // No points in the range: the order may still exist (snapshot or points outside the range).
      const known: Array<{ driver_id: string | null }> = await this.db.query(
        `SELECT view->>'driverId' AS driver_id FROM order_snapshots WHERE order_id = $1
         UNION ALL
         SELECT driver_id::text FROM (SELECT driver_id FROM route_points WHERE order_id = $1 ORDER BY sequence DESC LIMIT 1) last`,
        [orderId],
      );
      if (known.length === 0) return null;
      driverId = known.find((row) => row.driver_id)?.driver_id ?? null;
    }

    return {
      orderId,
      driverId,
      points: points.map((row) => ({
        lat: row.lat,
        lng: row.lng,
        deviceTime: row.device_time.toISOString(),
        sequence: Number(row.sequence),
      })),
    };
  }
}
