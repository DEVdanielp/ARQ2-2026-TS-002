/**
 * Initial schema of tracking-db (owned by the GPS Tracking Worker, ADR-003).
 *
 * Applied on startup (`migrationsRun: true`); `synchronize` is off, so only
 * migrations change the schema (see the Notification Service's migration for
 * why).
 *
 * Tables (spec section 3, "Storage ownership", and ADR-018)
 * --------------------------------------------------------
 * - driver_routes:    one row per driver: the LAST KNOWN LOCATION and its
 *                     sequence. `last_sequence` is the guard of F2-S4 (the
 *                     location never moves backward) and the row is the lock
 *                     that serialises the batches of one driver.
 * - route_orders:     the orders on each driver's route, replicated from
 *                     DriverAssigned / DriverUnassigned and the order status
 *                     events (ADR-015). Holds the NEARBY flag ("flag in the
 *                     driver route", spec 5.4) and the ETA throttle (ADR-013).
 * - gps_points:       the append-only history (ADR-011), partitioned by month
 *                     of the device time. Monthly partitions are created by
 *                     GpsPointPartitions at startup and daily; points outside
 *                     them (e.g. a device clock years off) land in the DEFAULT
 *                     partition instead of failing.
 * - processed_events: eventIds of assignment events already applied (spec 5.4:
 *                     "Idempotency: by eventId").
 * - outbox:           created by @libs/outbox's own migration.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793318400000 implements MigrationInterface {
  name = 'InitialSchema1793318400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE driver_routes (
        driver_id        uuid PRIMARY KEY,
        -- null until the first point; then the highest sequence ever applied.
        last_sequence    bigint CHECK (last_sequence >= 0),
        last_lat         double precision CHECK (last_lat BETWEEN -90 AND 90),
        last_lng         double precision CHECK (last_lng BETWEEN -180 AND 180),
        last_device_time timestamptz,
        last_batch_id    uuid,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CHECK ((last_sequence IS NULL) = (last_lat IS NULL)
           AND (last_sequence IS NULL) = (last_lng IS NULL)
           AND (last_sequence IS NULL) = (last_device_time IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE route_orders (
        order_id          uuid PRIMARY KEY,
        -- null = not assigned yet, or unassigned (DriverUnassigned).
        driver_id         uuid,
        destination_lat   double precision CHECK (destination_lat BETWEEN -90 AND 90),
        destination_lng   double precision CHECK (destination_lng BETWEEN -180 AND 180),
        -- Copy of the order status; CREATED/0 until the first status event arrives.
        status            text NOT NULL DEFAULT 'CREATED'
                          CHECK (status IN ('CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED')),
        -- aggregateVersion of the status applied; older events are ignored.
        status_version    integer NOT NULL DEFAULT 0 CHECK (status_version >= 0),
        nearby_reached_at timestamptz,
        nearby_trigger    text CHECK (nearby_trigger IN ('DISTANCE', 'ETA')),
        eta_checked_at    timestamptz,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CHECK ((destination_lat IS NULL) = (destination_lng IS NULL)),
        CHECK ((nearby_reached_at IS NULL) = (nearby_trigger IS NULL))
      )
    `);
    // Every GPS batch asks "which orders of this driver are on the way?".
    await queryRunner.query(
      `CREATE INDEX route_orders_monitored_idx ON route_orders (driver_id) WHERE status = 'ON_THE_WAY'`,
    );

    // A unique constraint on a partitioned table must include the partition
    // key, hence device_time. A redelivered point has the same three values and
    // is dropped by ON CONFLICT; the worker also filters stored sequences first.
    await queryRunner.query(`
      CREATE TABLE gps_points (
        driver_id       uuid NOT NULL,
        sequence        bigint NOT NULL CHECK (sequence >= 0),
        lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng             double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
        device_time     timestamptz NOT NULL,
        accuracy_meters double precision CHECK (accuracy_meters >= 0),
        speed_kmh       double precision CHECK (speed_kmh >= 0),
        batch_id        uuid NOT NULL,
        received_at     timestamptz NOT NULL,
        stored_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT gps_points_driver_sequence_uq UNIQUE (driver_id, sequence, device_time)
      ) PARTITION BY RANGE (device_time)
    `);
    // Audit queries: a driver's route over a time range (ADR-011).
    await queryRunner.query(`CREATE INDEX gps_points_driver_time_idx ON gps_points (driver_id, device_time)`);
    await queryRunner.query(`CREATE TABLE gps_points_default PARTITION OF gps_points DEFAULT`);

    await queryRunner.query(`
      CREATE TABLE processed_events (
        event_id     uuid PRIMARY KEY,
        event_type   text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE processed_events`);
    await queryRunner.query(`DROP TABLE gps_points`);
    await queryRunner.query(`DROP TABLE route_orders`);
    await queryRunner.query(`DROP TABLE driver_routes`);
  }
}
