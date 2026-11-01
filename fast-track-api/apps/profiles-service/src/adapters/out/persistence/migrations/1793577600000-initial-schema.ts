/**
 * Initial schema of profiles-db (spec 3 "Storage ownership", ADR-019).
 *
 * Migrations, not `synchronize`: a reviewed, versioned SQL script that runs
 * once, in order; TypeORM records it in its `migrations` table. The service
 * applies pending migrations on startup (`migrationsRun: true`).
 *
 * Tables
 * ------
 * - customers:           customer profiles (spec 3 `Customer`); `contact_version`
 *                        is the aggregateVersion of CustomerContactUpdated.
 * - drivers:             driver profiles, availability and capacity (spec 3 `Driver`).
 *                        `activeOrderIds` is not stored here: it is derived from
 *                        the active rows of `assignments`, so it can never drift.
 * - assignment_requests: one row per order, a local copy built from
 *                        orders.events (ADR-015): destination (needed by
 *                        DriverAssigned), last status and version, and the state
 *                        of the search for a driver (30 s retries, 10 min window).
 * - assignments:         who had which order and when (spec 4.1 GET /assignments).
 *                        A partial UNIQUE index allows at most ONE active
 *                        assignment per order (spec 5.4 DriverAssigned).
 * - processed_events:    eventIds already consumed (ADR-009).
 * The `outbox` table comes from @libs/outbox (OUTBOX_MIGRATIONS).
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793577600000 implements MigrationInterface {
  name = 'InitialSchema1793577600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE customers (
        customer_id     uuid PRIMARY KEY,               -- the JWT sub
        name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        email           text NOT NULL,
        phone           text,
        contact_version integer NOT NULL DEFAULT 1 CHECK (contact_version >= 1),
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE drivers (
        driver_id        uuid PRIMARY KEY,              -- the JWT sub
        name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        phone            text NOT NULL,
        vehicle_plate    text NOT NULL,
        availability     text NOT NULL DEFAULT 'OFFLINE' CHECK (availability IN ('AVAILABLE', 'EN_ROUTE', 'OFFLINE')),
        capacity         integer NOT NULL CHECK (capacity BETWEEN 1 AND 10),
        -- Tie-breaker of the selection rule (ADR-019): who has waited longest.
        last_assigned_at timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE assignment_requests (
        order_id            uuid PRIMARY KEY,
        customer_id         uuid NOT NULL,
        destination_address text,
        destination_lat     double precision NOT NULL CHECK (destination_lat BETWEEN -90 AND 90),
        destination_lng     double precision NOT NULL CHECK (destination_lng BETWEEN -180 AND 180),
        order_status        text NOT NULL CHECK (order_status IN ('CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED')),
        -- Highest aggregateVersion applied: older order events are ignored.
        order_version       integer NOT NULL,
        state               text NOT NULL CHECK (state IN ('PENDING', 'ASSIGNED', 'FAILED')),
        driver_id           uuid,
        attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        window_started_at   timestamptz NOT NULL,
        -- null = no attempt pending; the scheduler picks rows whose time has come.
        next_attempt_at     timestamptz,
        correlation_id      text NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX assignment_requests_due_idx ON assignment_requests (next_attempt_at)
       WHERE state = 'PENDING' AND order_status = 'CREATED'
    `);

    await queryRunner.query(`
      CREATE TABLE assignments (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id       uuid NOT NULL REFERENCES assignment_requests (order_id),
        driver_id      uuid NOT NULL REFERENCES drivers (driver_id),
        assigned_at    timestamptz NOT NULL,
        released_at    timestamptz,
        release_reason text CHECK (release_reason IN ('DELIVERED', 'CANCELLED', 'DRIVER_OFFLINE', 'REASSIGNED')),
        CHECK ((released_at IS NULL) = (release_reason IS NULL))
      )
    `);
    // At most one active assignment per order.
    await queryRunner.query(
      `CREATE UNIQUE INDEX assignments_one_active_per_order_uq ON assignments (order_id) WHERE released_at IS NULL`,
    );
    // Active orders of a driver (activeOrderIds, capacity checks).
    await queryRunner.query(
      `CREATE INDEX assignments_active_by_driver_idx ON assignments (driver_id) WHERE released_at IS NULL`,
    );
    // History of an order (GET /assignments).
    await queryRunner.query(
      `CREATE INDEX assignments_by_order_idx ON assignments (order_id, assigned_at)`,
    );

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
    await queryRunner.query(`DROP TABLE assignments`);
    await queryRunner.query(`DROP TABLE assignment_requests`);
    await queryRunner.query(`DROP TABLE drivers`);
    await queryRunner.query(`DROP TABLE customers`);
  }
}
