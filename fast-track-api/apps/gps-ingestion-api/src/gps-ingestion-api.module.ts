/**
 * Root module of the GPS Ingestion API (F2): wires every layer together.
 *
 *   adapters/in/http   (LocationsController)
 *        │ calls
 *   application        (IngestGpsBatch + GpsBatchPublisher port)
 *        │ implemented by
 *   adapters/out/kafka (KafkaGpsBatchPublisher)
 *
 * No database: the service is stateless (spec 1, ADR-003).
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { DEFAULT_PUBLISH_TIMEOUT_MS, validateEnvironment, type IngestionEnvironment } from './config/environment.js';
import { LocationsController } from './adapters/in/http/locations.controller.js';
import { KafkaGpsBatchPublisher, PublisherSettings } from './adapters/out/kafka/kafka-gps-batch-publisher.js';
import { IngestGpsBatch } from './application/ingest-gps-batch.js';
import { GpsBatchPublisher } from './application/ports.js';

@Module({
  imports: [
    // Must stay FIRST: it loads the .env file into process.env synchronously,
    // and KafkaModule.forRoot() below reads KAFKA_BROKERS from process.env.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the variables come from docker-compose.yml.
      envFilePath: 'apps/gps-ingestion-api/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'gps-ingestion-api' }),
  ],
  controllers: [LocationsController],
  providers: [
    {
      provide: PublisherSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<IngestionEnvironment, true>) =>
        new PublisherSettings(config.get('GPS_PUBLISH_TIMEOUT_MS', { infer: true }) ?? DEFAULT_PUBLISH_TIMEOUT_MS),
    },
    { provide: GpsBatchPublisher, useClass: KafkaGpsBatchPublisher },
    IngestGpsBatch,
  ],
})
export class GpsIngestionApiModule {}
