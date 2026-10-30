/**
 * Root module of the GPS Tracking Worker (F2, F5): wires every layer together.
 *
 *   adapters/in/kafka      (GpsTrackingConsumer)
 *        │ calls
 *   application            (use cases + ports)
 *        │ implemented by
 *   adapters/out           (PostgreSQL tracking-db + outbox, Maps/ETA provider)
 *
 * The worker has no HTTP API (spec 4 lists none): it is a pure Kafka consumer,
 * started with NestFactory.createApplicationContext in main.ts.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { OutboxModule } from '@libs/outbox';
import { TRACKING_DEFAULTS, validateEnvironment, type TrackingEnvironment } from './config/environment.js';
import { PersistenceModule } from './adapters/out/persistence/persistence.module.js';
import { createEtaProvider } from './adapters/out/eta/eta-providers.js';
import { GpsTrackingConsumer } from './adapters/in/kafka/gps-tracking.consumer.js';
import { EtaProvider, TrackingSettings } from './application/ports.js';
import { ProcessGpsBatch } from './application/process-gps-batch.js';
import { AssignRouteOrder, TrackOrderStatus, UnassignRouteOrder } from './application/route-orders.use-cases.js';

type Config = ConfigService<TrackingEnvironment, true>;

/** Reads an optional numeric variable, falling back to its documented default. */
function setting(config: Config, key: keyof typeof TRACKING_DEFAULTS): number {
  return config.get(key, { infer: true }) ?? TRACKING_DEFAULTS[key];
}

@Module({
  imports: [
    // Must stay FIRST: it loads the .env file into process.env synchronously,
    // and KafkaModule.forRoot() below reads KAFKA_BROKERS from process.env.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the variables come from docker-compose.yml.
      envFilePath: 'apps/gps-tracking-worker/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'gps-tracking-worker' }),
    PersistenceModule,
    OutboxModule.forRoot(),
  ],
  providers: [
    {
      provide: TrackingSettings,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new TrackingSettings(
          setting(config, 'NEARBY_DISTANCE_METERS'),
          setting(config, 'NEARBY_ETA_SECONDS'),
          setting(config, 'ETA_LOOKUP_RADIUS_METERS'),
          setting(config, 'ETA_MIN_INTERVAL_SECONDS'),
        ),
    },
    {
      provide: EtaProvider,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        createEtaProvider(config.get('ETA_PROVIDER_URL', { infer: true }), setting(config, 'ETA_TIMEOUT_MS')),
    },

    // Application layer.
    ProcessGpsBatch,
    TrackOrderStatus,
    AssignRouteOrder,
    UnassignRouteOrder,

    // Inbound Kafka adapter.
    GpsTrackingConsumer,
  ],
})
export class GpsTrackingWorkerModule {}
