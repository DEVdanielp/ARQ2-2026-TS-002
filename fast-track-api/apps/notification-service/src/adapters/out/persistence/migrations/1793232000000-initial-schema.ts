/**
 * Initial schema of notifications-db.
 *
 * Why migrations (and not `synchronize: true`)
 * --------------------------------------------
 * `synchronize` lets TypeORM alter tables to match the entities on every
 * start, which can silently drop columns and data. A migration is a reviewed,
 * versioned SQL script: it runs once, in order, and TypeORM records it in the
 * `migrations` table so it never runs twice. The service applies pending
 * migrations on startup (`migrationsRun: true` in persistence.module.ts).
 *
 * Tables (spec section 3, "Storage ownership", plus team decisions)
 * ----------------------------------------------------------------
 * - preferences:      per-customer channel preferences (spec 4.5).
 * - contacts:         local copy of the customer's contact data, replicated
 *                     from `CustomerContactUpdated` (ADR-015).
 * - devices:          push device tokens (spec 4.5, PUT /notifications/devices).
 * - order_recipients: orderId -> customerId, replicated from `OrderCreated`.
 *                     Order events do not carry customerId, so this is how the
 *                     service knows whom to notify (team decision, option 1a).
 * - notification_log: one row per (order, type, channel); its UNIQUE constraint
 *                     is the idempotency rule of spec 5.2 / ADR-009.
 * - processed_events: eventIds already handled, for events that have no
 *                     natural unique key (e.g. AssignmentFailed alerts).
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793232000000 implements MigrationInterface {
  name = 'InitialSchema1793232000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE preferences (
        customer_id       uuid PRIMARY KEY,
        push              boolean NOT NULL DEFAULT true,
        email             boolean NOT NULL DEFAULT true,
        notify_on_created boolean NOT NULL DEFAULT false,
        updated_at        timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE contacts (
        customer_id       uuid PRIMARY KEY,
        name              text NOT NULL,
        email             text NOT NULL,
        phone             text,
        -- Highest aggregateVersion applied; older events are ignored (spec 5.4).
        aggregate_version integer NOT NULL,
        updated_at        timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The token is the key: if the same phone logs in with another account,
    // the token moves to the new customer instead of notifying both.
    await queryRunner.query(`
      CREATE TABLE devices (
        device_token text PRIMARY KEY,
        customer_id  uuid NOT NULL,
        platform     text NOT NULL CHECK (platform IN ('ANDROID', 'IOS', 'WEB')),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX devices_customer_id_idx ON devices (customer_id)`);

    await queryRunner.query(`
      CREATE TABLE order_recipients (
        order_id    uuid PRIMARY KEY,
        customer_id uuid NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // PENDING is not in the spec's status enum: it marks a row that was claimed
    // but whose first send has not finished yet (see the README's open points).
    await queryRunner.query(`
      CREATE TABLE notification_log (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id    uuid NOT NULL,
        customer_id uuid NOT NULL,
        type        text NOT NULL CHECK (type IN ('ORDER_CREATED', 'ON_THE_WAY', 'NEARBY', 'DELIVERED', 'CANCELLED')),
        channel     text NOT NULL CHECK (channel IN ('PUSH', 'EMAIL')),
        status      text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'RETRYING', 'DEAD_LETTERED')),
        attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error  text,
        sent_at     timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notification_log_order_type_channel_uq UNIQUE (order_id, type, channel)
      )
    `);

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
    await queryRunner.query(`DROP TABLE notification_log`);
    await queryRunner.query(`DROP TABLE order_recipients`);
    await queryRunner.query(`DROP TABLE devices`);
    await queryRunner.query(`DROP TABLE contacts`);
    await queryRunner.query(`DROP TABLE preferences`);
  }
}
