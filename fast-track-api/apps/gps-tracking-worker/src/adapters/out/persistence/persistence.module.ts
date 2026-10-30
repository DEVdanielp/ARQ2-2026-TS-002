/**
 * PersistenceModule: the connection to tracking-db and the repositories.
 *
 * - The URL comes from the validated `DATABASE_URL` (config/environment.ts).
 * - Pending migrations run on startup, so a fresh database gets its tables and
 *   an existing one is upgraded before the worker consumes anything.
 * - `synchronize` is off: only migrations change the schema.
 * - Migrations are listed explicitly because the service is bundled into one
 *   file by rspack, where file globs cannot find them. The only entity is the
 *   outbox's; the worker's repositories use SQL (see repositories.ts).
 * - Each port (abstract class) is bound to its PostgreSQL implementation here.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OUTBOX_ENTITIES, OUTBOX_MIGRATIONS } from '@libs/outbox';
import type { TrackingEnvironment } from '../../../config/environment.js';
import { DriverTrackingStore, RouteOrderRepository } from '../../../application/ports.js';
import { GpsPointPartitions } from './gps-point-partitions.js';
import { InitialSchema1793318400000 } from './migrations/1793318400000-initial-schema.js';
import { PostgresDriverTrackingStore, PostgresRouteOrderRepository } from './repositories.js';

/** Migrations of tracking-db, in order. Exported for the integration test. */
export const TRACKING_MIGRATIONS = [InitialSchema1793318400000, ...OUTBOX_MIGRATIONS];

const REPOSITORIES = [
  { provide: DriverTrackingStore, useClass: PostgresDriverTrackingStore },
  { provide: RouteOrderRepository, useClass: PostgresRouteOrderRepository },
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<TrackingEnvironment, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: [...OUTBOX_ENTITIES],
        migrations: TRACKING_MIGRATIONS,
        migrationsRun: true,
        synchronize: false,
      }),
    }),
  ],
  providers: [...REPOSITORIES, GpsPointPartitions],
  exports: REPOSITORIES.map((binding) => binding.provide),
})
export class PersistenceModule {}
