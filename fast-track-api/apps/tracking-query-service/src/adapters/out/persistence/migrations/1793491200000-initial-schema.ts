/**
 * Initial schema of query-archive-db (owned by Tracking Query, ADR-003).
 *
 * Applied on startup (`migrationsRun: true`); `synchronize` is off, so only
 * migrations change the schema.
 *
 * Tables (spec section 3, "Storage ownership")
 * --------------------------------------------
 * - order_snapshots: the last tracking view of each order, as JSON. Written on
 *                    every order / assignment / NEARBY change, so a terminal
 *                    order can still be served after its 24 h in Redis
 *                    (ADR-002, F3-S5). `revision` keeps the newest copy.
 * - route_points:    every LocationUpdated received, for the route audit of
 *                    operations (spec 4.4 `GET /tracking/{orderId}/route`).
 *                    One row per (order, sequence): redeliveries are no-ops.
 *
 * No outbox and no processed_events: Tracking Query publishes nothing, and its
 * writes are idempotent by revision / sequence.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793491200000 implements MigrationInterface {
  name = 'InitialSchema1793491200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE order_snapshots (
        order_id    uuid PRIMARY KEY,
        customer_id uuid,
        status      text NOT NULL CHECK (status IN ('CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED')),
        version     integer NOT NULL,
        revision    bigint NOT NULL,
        view        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE route_points (
        order_id    uuid NOT NULL,
        sequence    bigint NOT NULL CHECK (sequence >= 0),
        driver_id   uuid NOT NULL,
        lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
        device_time timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (order_id, sequence)
      )
    `);

    // Route audit filters one order by device time.
    await queryRunner.query(`CREATE INDEX route_points_order_time_idx ON route_points (order_id, device_time)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE route_points`);
    await queryRunner.query(`DROP TABLE order_snapshots`);
  }
}
