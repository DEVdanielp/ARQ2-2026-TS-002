/**
 * Migration that creates the `outbox` table. Each service registers it in
 * its own TypeORM `migrations` list (see `OUTBOX_MIGRATIONS`), so the table
 * lives in the service's own database.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxTable1793232000001 implements MigrationInterface {
  name = 'CreateOutboxTable1793232000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox (
        id            bigserial PRIMARY KEY,
        topic         text NOT NULL,
        message_key   text NOT NULL,
        envelope      jsonb NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        publish_after timestamptz,
        published_at  timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text
      )
    `);
    // The relay only looks at pending rows; a partial index keeps that query
    // fast however many published rows accumulate.
    await queryRunner.query(`CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE outbox`);
  }
}
