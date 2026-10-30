/**
 * PersistenceModule: the connection to notifications-db and the repositories.
 *
 * - The URL comes from the validated `DATABASE_URL` (config/environment.ts).
 * - Pending migrations run on startup, so a fresh database gets its tables and
 *   an existing one is upgraded before the service accepts traffic.
 * - `synchronize` is off: only migrations change the schema.
 * - Entities and migrations are listed explicitly because the service is
 *   bundled into one file by rspack, where file globs cannot find them.
 * - Each port (abstract class) is bound to its TypeORM implementation here;
 *   use cases only ever see the port.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OUTBOX_ENTITIES, OUTBOX_MIGRATIONS } from '@libs/outbox';
import type { NotificationEnvironment } from '../../../config/environment.js';
import {
  ContactRepository,
  DeviceRepository,
  NotificationLogRepository,
  OrderRecipientRepository,
  PreferencesRepository,
  ProcessedEventRepository,
} from '../../../application/ports.js';
import { NOTIFICATION_ENTITIES } from './entities.js';
import { InitialSchema1793232000000 } from './migrations/1793232000000-initial-schema.js';
import {
  TypeOrmContactRepository,
  TypeOrmDeviceRepository,
  TypeOrmNotificationLogRepository,
  TypeOrmOrderRecipientRepository,
  TypeOrmPreferencesRepository,
  TypeOrmProcessedEventRepository,
} from './repositories.js';

const REPOSITORIES = [
  { provide: PreferencesRepository, useClass: TypeOrmPreferencesRepository },
  { provide: DeviceRepository, useClass: TypeOrmDeviceRepository },
  { provide: ContactRepository, useClass: TypeOrmContactRepository },
  { provide: OrderRecipientRepository, useClass: TypeOrmOrderRecipientRepository },
  { provide: ProcessedEventRepository, useClass: TypeOrmProcessedEventRepository },
  { provide: NotificationLogRepository, useClass: TypeOrmNotificationLogRepository },
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<NotificationEnvironment, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: [...NOTIFICATION_ENTITIES, ...OUTBOX_ENTITIES],
        migrations: [InitialSchema1793232000000, ...OUTBOX_MIGRATIONS],
        migrationsRun: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(NOTIFICATION_ENTITIES),
  ],
  providers: REPOSITORIES,
  exports: REPOSITORIES.map((binding) => binding.provide),
})
export class PersistenceModule {}
