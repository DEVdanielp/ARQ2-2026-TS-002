/**
 * PostgreSQL implementations of the ports (application/ports.ts).
 *
 * Plain SQL instead of TypeORM entities: the history is a partitioned,
 * append-only table without a primary key, and the rules below rely on row
 * locks, `ON CONFLICT` and conditional `UPDATE ... WHERE`, which read more
 * clearly as SQL. Idempotency lives in those statements, not in "check then
 * write" code, so concurrent writers cannot both pass a check.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { GpsPoint } from '@libs/events';
import { OutboxService, type OutboxMessage } from '@libs/outbox';
import type { ProximityTrigger } from '../../../domain/proximity.js';
import type { MonitoredOrder } from '../../../domain/tracking.js';
import {
  DriverTrackingStore,
  RouteOrderRepository,
  type AssignOutcome,
  type BatchInfo,
  type DriverAssignment,
  type DriverTrackingSession,
  type DriverUnassignment,
  type OrderStatusChange,
  type UnassignOutcome,
} from '../../../application/ports.js';

/**
 * Rows of a `... RETURNING` statement. TypeORM's postgres driver returns the
 * rows for INSERT/SELECT but `[rows, rowCount]` for UPDATE/DELETE.
 */
function returnedRows(result: unknown): unknown[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0];
  }
  return Array.isArray(result) ? result : [];
}

/** bigint columns arrive as strings (they can exceed 2^53; ours never do, see the DTO). */
const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));

interface MonitoredOrderRow {
  order_id: string;
  driver_id: string;
  destination_lat: number;
  destination_lng: number;
  nearby_reached_at: Date | null;
  eta_checked_at: Date | null;
}

const MONITORED_ORDERS_SQL = `
  SELECT order_id, driver_id, destination_lat, destination_lng, nearby_reached_at, eta_checked_at
    FROM route_orders
   WHERE driver_id = $1 AND status = 'ON_THE_WAY' AND destination_lat IS NOT NULL
   ORDER BY order_id`;

function toMonitoredOrder(row: MonitoredOrderRow): MonitoredOrder {
  return {
    orderId: row.order_id,
    driverId: row.driver_id,
    destination: { lat: row.destination_lat, lng: row.destination_lng },
    nearbyReachedAt: row.nearby_reached_at,
    etaCheckedAt: row.eta_checked_at,
  };
}

/** One driver's session: every statement runs on the transaction's manager. */
class PostgresDriverSession implements DriverTrackingSession {
  constructor(
    private readonly manager: EntityManager,
    private readonly outbox: OutboxService,
    private readonly driverId: string,
    readonly lastSequence: number | null,
  ) {}

  async findStoredSequences(sequences: number[]): Promise<Set<number>> {
    const rows: Array<{ sequence: string }> = await this.manager.query(
      `SELECT sequence FROM gps_points WHERE driver_id = $1 AND sequence = ANY($2::bigint[])`,
      [this.driverId, sequences],
    );
    return new Set(rows.map((row) => Number(row.sequence)));
  }

  async appendPoints(points: GpsPoint[], batch: BatchInfo): Promise<void> {
    // One statement for the whole batch: unnest() turns the arrays into rows.
    await this.manager.query(
      `INSERT INTO gps_points (driver_id, sequence, lat, lng, device_time, accuracy_meters, speed_kmh, batch_id, received_at)
       SELECT $1, p.sequence, p.lat, p.lng, p.device_time, p.accuracy_meters, p.speed_kmh, $8, $9
         FROM unnest($2::bigint[], $3::float8[], $4::float8[], $5::timestamptz[], $6::float8[], $7::float8[])
              AS p(sequence, lat, lng, device_time, accuracy_meters, speed_kmh)
       ON CONFLICT (driver_id, sequence, device_time) DO NOTHING`,
      [
        this.driverId,
        points.map((p) => p.sequence),
        points.map((p) => p.lat),
        points.map((p) => p.lng),
        points.map((p) => p.deviceTime),
        points.map((p) => p.accuracyMeters ?? null),
        points.map((p) => p.speedKmh ?? null),
        batch.batchId,
        batch.receivedAt,
      ],
    );
  }

  async moveLocation(point: GpsPoint, batch: BatchInfo): Promise<void> {
    await this.manager.query(
      `UPDATE driver_routes
          SET last_sequence = $2, last_lat = $3, last_lng = $4, last_device_time = $5, last_batch_id = $6, updated_at = now()
        WHERE driver_id = $1`,
      [this.driverId, point.sequence, point.lat, point.lng, point.deviceTime, batch.batchId],
    );
  }

  async lockMonitoredOrders(): Promise<MonitoredOrder[]> {
    // FOR UPDATE: a concurrent OrderDelivered for one of these orders waits
    // for this batch to commit (and vice versa), and the NEARBY flag below is
    // decided on rows nobody else is changing.
    const rows: MonitoredOrderRow[] = await this.manager.query(`${MONITORED_ORDERS_SQL} FOR UPDATE`, [this.driverId]);
    return rows.map(toMonitoredOrder);
  }

  async markNearby(orderId: string, trigger: ProximityTrigger, at: Date): Promise<boolean> {
    const result: unknown = await this.manager.query(
      `UPDATE route_orders SET nearby_reached_at = $2, nearby_trigger = $3, updated_at = now()
        WHERE order_id = $1 AND nearby_reached_at IS NULL
       RETURNING order_id`,
      [orderId, at, trigger],
    );
    return returnedRows(result).length > 0;
  }

  async recordEtaCheck(orderId: string, at: Date): Promise<void> {
    await this.manager.query(`UPDATE route_orders SET eta_checked_at = $2, updated_at = now() WHERE order_id = $1`, [orderId, at]);
  }

  async publish(message: OutboxMessage): Promise<void> {
    // Same transaction as the history and the location (ADR-005).
    await this.outbox.enqueue(this.manager, message);
  }
}

@Injectable()
export class PostgresDriverTrackingStore extends DriverTrackingStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  withDriver<T>(driverId: string, work: (session: DriverTrackingSession) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      // Create the driver's row on first use, then lock it until commit: the
      // batches of one driver are applied strictly one after another, even if
      // two instances briefly consume the same partition during a rebalance.
      await manager.query(`INSERT INTO driver_routes (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`, [driverId]);
      const [route]: Array<{ last_sequence: string | null }> = await manager.query(
        `SELECT last_sequence FROM driver_routes WHERE driver_id = $1 FOR UPDATE`,
        [driverId],
      );
      return work(new PostgresDriverSession(manager, this.outbox, driverId, toNumber(route.last_sequence)));
    });
  }

  async findMonitoredOrders(driverId: string): Promise<MonitoredOrder[]> {
    const rows: MonitoredOrderRow[] = await this.dataSource.query(MONITORED_ORDERS_SQL, [driverId]);
    return rows.map(toMonitoredOrder);
  }
}

@Injectable()
export class PostgresRouteOrderRepository extends RouteOrderRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async applyStatus(change: OrderStatusChange): Promise<boolean> {
    // Insert, or update only if the version is newer (ADR-009). The driver is
    // filled from the event only while unknown (DriverAssigned not seen yet).
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO route_orders (order_id, driver_id, status, status_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO UPDATE
          SET status = EXCLUDED.status, status_version = EXCLUDED.status_version,
              driver_id = COALESCE(route_orders.driver_id, EXCLUDED.driver_id), updated_at = now()
        WHERE route_orders.status_version < EXCLUDED.status_version
       RETURNING order_id`,
      [change.orderId, change.driverId, change.status, change.version],
    );
    return rows.length > 0;
  }

  assign(eventId: string, assignment: DriverAssignment): Promise<AssignOutcome> {
    return this.dataSource.transaction(async (manager) => {
      if (!(await markProcessed(manager, eventId, 'DriverAssigned'))) return 'DUPLICATE';
      // A terminal order keeps its row untouched (spec 1: assignment events
      // for terminal orders are ignored).
      const rows: unknown[] = await manager.query(
        `INSERT INTO route_orders (order_id, driver_id, destination_lat, destination_lng)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id) DO UPDATE
            SET driver_id = EXCLUDED.driver_id, destination_lat = EXCLUDED.destination_lat,
                destination_lng = EXCLUDED.destination_lng, eta_checked_at = NULL, updated_at = now()
          WHERE route_orders.status NOT IN ('DELIVERED', 'CANCELLED')
         RETURNING order_id`,
        [assignment.orderId, assignment.driverId, assignment.destination.lat, assignment.destination.lng],
      );
      return rows.length > 0 ? 'ASSIGNED' : 'IGNORED_TERMINAL';
    });
  }

  unassign(eventId: string, unassignment: DriverUnassignment): Promise<UnassignOutcome> {
    return this.dataSource.transaction(async (manager) => {
      if (!(await markProcessed(manager, eventId, 'DriverUnassigned'))) return 'DUPLICATE';
      const result: unknown = await manager.query(
        `UPDATE route_orders SET driver_id = NULL, eta_checked_at = NULL, updated_at = now()
          WHERE order_id = $1 AND driver_id = $2 AND status = 'CREATED'
         RETURNING order_id`,
        [unassignment.orderId, unassignment.driverId],
      );
      return returnedRows(result).length > 0 ? 'UNASSIGNED' : 'IGNORED';
    });
  }
}

/** @returns false if the event was already processed. */
async function markProcessed(manager: EntityManager, eventId: string, eventType: string): Promise<boolean> {
  const rows: unknown[] = await manager.query(
    `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, eventType],
  );
  return rows.length > 0;
}
