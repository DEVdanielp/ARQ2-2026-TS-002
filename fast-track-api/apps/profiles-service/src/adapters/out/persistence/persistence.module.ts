/**
 * PersistenceModule: the connection to profiles-db and the store.
 *
 * - The URL comes from the validated `DATABASE_URL` (config/environment.ts).
 * - Pending migrations run on startup, so a fresh database gets its tables and
 *   an existing one is upgraded before the service accepts traffic.
 * - `synchronize` is off: only migrations change the schema.
 * - Migrations are listed explicitly because the service is bundled into one
 *   file by rspack, where file globs cannot find them. The only entity is the
 *   outbox's; the store uses SQL (see postgres-profiles.store.ts).
 * - The `ProfilesStore` port is bound to its PostgreSQL implementation here.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OUTBOX_ENTITIES, OUTBOX_MIGRATIONS } from '@libs/outbox';
import type { ProfilesEnvironment } from '../../../config/environment.js';
import { ProfilesStore } from '../../../application/ports.js';
import { InitialSchema1793577600000 } from './migrations/1793577600000-initial-schema.js';
import { PostgresProfilesStore } from './postgres-profiles.store.js';

/** Migrations of profiles-db, in order. Exported for the integration test. */
export const PROFILES_MIGRATIONS = [
  ...OUTBOX_MIGRATIONS,
  InitialSchema1793577600000,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ProfilesEnvironment, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: [...OUTBOX_ENTITIES],
        migrations: PROFILES_MIGRATIONS,
        migrationsRun: true,
        synchronize: false,
      }),
    }),
  ],
  providers: [{ provide: ProfilesStore, useClass: PostgresProfilesStore }],
  exports: [ProfilesStore],
})
export class PersistenceModule {}
