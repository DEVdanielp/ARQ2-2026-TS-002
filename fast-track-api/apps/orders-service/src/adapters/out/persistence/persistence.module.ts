/**
 * PersistenceModule: the connection to orders-db and the store.
 *
 * - The URL comes from the validated `DATABASE_URL` (config/environment.ts).
 * - Pending migrations run on startup, so a fresh database gets its tables and
 *   an existing one is upgraded before the service accepts traffic.
 * - `synchronize` is off: only migrations change the schema.
 * - Migrations are listed explicitly because the service is bundled into one
 *   file by rspack, where file globs cannot find them. The only entity is the
 *   outbox's; the store uses SQL (see postgres-orders.store.ts).
 * - The `OrdersStore` port is bound to its PostgreSQL implementation here.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OUTBOX_ENTITIES, OUTBOX_MIGRATIONS } from '@libs/outbox';
import type { OrdersEnvironment } from '../../../config/environment.js';
import { OrdersStore } from '../../../application/ports.js';
import { InitialSchema1793664000000 } from './migrations/1793664000000-initial-schema.js';
import { PostgresOrdersStore } from './postgres-orders.store.js';

/** Migrations of orders-db, in order. Exported for the integration test. */
export const ORDERS_MIGRATIONS = [
  ...OUTBOX_MIGRATIONS,
  InitialSchema1793664000000,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<OrdersEnvironment, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: [...OUTBOX_ENTITIES],
        migrations: ORDERS_MIGRATIONS,
        migrationsRun: true,
        synchronize: false,
      }),
    }),
  ],
  providers: [{ provide: OrdersStore, useClass: PostgresOrdersStore }],
  exports: [OrdersStore],
})
export class PersistenceModule {}
