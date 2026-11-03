/**
 * PersistenceModule: the connection to query-archive-db and the archive.
 *
 * - The URL comes from the validated `DATABASE_URL` (config/environment.ts).
 * - Pending migrations run on startup; `synchronize` is off.
 * - Migrations are listed explicitly because the service is bundled into one
 *   file by rspack, where file globs cannot find them. There are no entities:
 *   the archive uses SQL (see postgres-tracking-archive.ts).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { TrackingQueryEnvironment } from '../../../config/environment.js';
import { TrackingArchive } from '../../../application/ports.js';
import { InitialSchema1793491200000 } from './migrations/1793491200000-initial-schema.js';
import { PostgresTrackingArchive } from './postgres-tracking-archive.js';

/** Migrations of query-archive-db, in order. Exported for the integration test. */
export const ARCHIVE_MIGRATIONS = [InitialSchema1793491200000];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<TrackingQueryEnvironment, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: [],
        migrations: ARCHIVE_MIGRATIONS,
        migrationsRun: true,
        synchronize: false,
      }),
    }),
  ],
  providers: [{ provide: TrackingArchive, useClass: PostgresTrackingArchive }],
  exports: [TrackingArchive],
})
export class PersistenceModule {}
