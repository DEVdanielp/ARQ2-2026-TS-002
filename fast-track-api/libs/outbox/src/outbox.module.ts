/**
 * OutboxModule: provides OutboxService (enqueue) and starts OutboxRelay.
 *
 * Requirements in the service:
 * - `KafkaModule.forRoot()` (the relay publishes with KafkaProducerService);
 * - `TypeOrmModule.forRoot*()` with `OUTBOX_ENTITIES` in `entities` and
 *   `OUTBOX_MIGRATIONS` in `migrations`, so the table exists in its database.
 *
 *   imports: [KafkaModule.forRoot(...), TypeOrmModule.forRootAsync(...), OutboxModule.forRoot()]
 */
import { DynamicModule, Module } from '@nestjs/common';
import { OutboxEntity } from './outbox.entity.js';
import { CreateOutboxTable1793232000001 } from './outbox.migration.js';
import { OUTBOX_OPTIONS, OutboxRelay, type OutboxOptions } from './outbox.relay.js';
import { OutboxService } from './outbox.service.js';

/** Add to the service's TypeORM `entities`. */
export const OUTBOX_ENTITIES = [OutboxEntity];

/** Add to the service's TypeORM `migrations`. */
export const OUTBOX_MIGRATIONS = [CreateOutboxTable1793232000001];

const DEFAULTS: OutboxOptions = {
  pollIntervalMs: 200,
  batchSize: 50,
  retentionHours: 24 * 7,
  enabled: true,
};

@Module({})
export class OutboxModule {
  /** Registers the outbox for the whole application (global module). */
  static forRoot(options: Partial<OutboxOptions> = {}): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      providers: [{ provide: OUTBOX_OPTIONS, useValue: { ...DEFAULTS, ...options } }, OutboxService, OutboxRelay],
      exports: [OutboxService, OutboxRelay],
    };
  }
}
