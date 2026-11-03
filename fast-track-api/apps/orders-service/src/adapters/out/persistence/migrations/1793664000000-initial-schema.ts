/**
 * Initial schema of orders-db (spec 3 "Storage ownership").
 *
 * Migrations, not `synchronize`: a reviewed, versioned SQL script that runs
 * once, in order; TypeORM records it in its `migrations` table. The service
 * applies pending migrations on startup (`migrationsRun: true`).
 *
 * Tables
 * ------
 * - orders:           the source of truth of every order (spec 3 `Order`).
 *                     `version` starts at 1 and increases on every change.
 * - rejected_intents: intents the state engine did not apply (spec 5.4:
 *                     "rejected and recorded, never retried").
 * - idempotency_keys: responses of `POST /orders` and `POST /orders/{id}/intents`,
 *                     returned again on a repeated key for 24 h (spec 2). A key
 *                     belongs to one user and one endpoint.
 * - processed_events: eventIds already consumed; intents use their intentId (ADR-009).
 * The `outbox` table comes from @libs/outbox (OUTBOX_MIGRATIONS).
 *
 * `orders` also holds the rules a bug must never break, so the database refuses
 * them even if the code tried: a cancelled order says who cancelled it, and
 * operations always gives a reason (spec 4.2).
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793664000000 implements MigrationInterface {
  name = 'InitialSchema1793664000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE orders (
        order_id            uuid PRIMARY KEY,
        customer_id         uuid NOT NULL,                 -- the JWT sub of the customer
        driver_id           uuid,                          -- null until DriverAssigned
        destination_address text NOT NULL CHECK (char_length(destination_address) BETWEEN 1 AND 300),
        destination_lat     double precision NOT NULL CHECK (destination_lat BETWEEN -90 AND 90),
        destination_lng     double precision NOT NULL CHECK (destination_lng BETWEEN -180 AND 180),
        notes               text,
        status              text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED')),
        version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        cancellation_actor  text CHECK (cancellation_actor IN ('CUSTOMER', 'DRIVER', 'OPERATIONS', 'SYSTEM')),
        cancellation_reason text CHECK (char_length(cancellation_reason) <= 300),
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cancelled_orders_have_actor CHECK ((status = 'CANCELLED') = (cancellation_actor IS NOT NULL)),
        CONSTRAINT operations_cancellation_has_reason CHECK (
          cancellation_actor IS DISTINCT FROM 'OPERATIONS' OR cancellation_reason IS NOT NULL
        )
      )
    `);
    // GET /orders of each role, newest first.
    await queryRunner.query(
      `CREATE INDEX orders_by_customer_idx ON orders (customer_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX orders_by_driver_idx ON orders (driver_id, created_at DESC) WHERE driver_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX orders_by_status_idx ON orders (status, created_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE rejected_intents (
        intent_id   uuid PRIMARY KEY,
        order_id    uuid NOT NULL,
        type        text NOT NULL CHECK (type IN ('PICKUP_CONFIRMED', 'DELIVERY_CONFIRMED', 'CANCELLATION_REQUESTED')),
        actor       text NOT NULL CHECK (actor IN ('CUSTOMER', 'DRIVER', 'OPERATIONS')),
        actor_id    uuid NOT NULL,
        reason      text NOT NULL,
        rejected_at timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX rejected_intents_by_order_idx ON rejected_intents (order_id, rejected_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        owner_id        uuid NOT NULL,
        scope           text NOT NULL,
        idempotency_key uuid NOT NULL,
        request_hash    text NOT NULL,
        response_status smallint NOT NULL,
        response_body   jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        expires_at      timestamptz NOT NULL,
        PRIMARY KEY (owner_id, scope, idempotency_key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE processed_events (
        event_id     uuid PRIMARY KEY,
        event_type   text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX processed_events_age_idx ON processed_events (processed_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE processed_events`);
    await queryRunner.query(`DROP TABLE idempotency_keys`);
    await queryRunner.query(`DROP TABLE rejected_intents`);
    await queryRunner.query(`DROP TABLE orders`);
  }
}
