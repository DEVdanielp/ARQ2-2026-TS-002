/**
 * Root module of the Tracking Query Service (F3): wires every layer together.
 *
 *   adapters/in   (HTTP controller + SSE, Kafka consumer)
 *        │ call
 *   application   (use cases + ports)
 *        │ implemented by
 *   adapters/out  (Redis view + Lua, Redis Pub/Sub, PostgreSQL archive)
 *
 * This file is the only place that knows which implementation backs each
 * port (ADR-014).
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { validateEnvironment, type TrackingQueryEnvironment } from './config/environment.js';
import { PersistenceModule } from './adapters/out/persistence/persistence.module.js';
import { RedisModule } from './adapters/out/redis/redis.module.js';
import { RedisTrackingViewStore } from './adapters/out/redis/redis-tracking-view.store.js';
import { RedisViewChangeBus } from './adapters/out/redis/redis-view-change.bus.js';
import { TrackingController } from './adapters/in/http/tracking.controller.js';
import { TrackingEventsConsumer } from './adapters/in/kafka/tracking-events.consumer.js';
import { Clock, TrackingQuerySettings, TrackingViewStore, ViewChangeBus } from './application/ports.js';
import { ProjectTrackingEvent } from './application/project-tracking-event.js';
import { GetTrackingView } from './application/get-tracking-view.js';
import { WatchTrackingView } from './application/watch-tracking-view.js';
import { GetOrderRoute } from './application/get-route.js';

type Config = ConfigService<TrackingQueryEnvironment, true>;

@Module({
  imports: [
    // Must stay FIRST: ConfigModule.forRoot() loads the .env file into
    // process.env synchronously, and KafkaModule.forRoot() below reads
    // KAFKA_BROKERS from process.env when this array is evaluated.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the variables come from docker-compose.yml.
      envFilePath: 'apps/tracking-query-service/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'tracking-query-service' }),
    RedisModule,
    PersistenceModule,
  ],
  controllers: [TrackingController],
  providers: [
    // Settings and outbound adapters.
    {
      provide: TrackingQuerySettings,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new TrackingQuerySettings(config.get('TERMINAL_VIEW_TTL_SECONDS', { infer: true })),
    },
    Clock,
    { provide: TrackingViewStore, useClass: RedisTrackingViewStore },
    RedisViewChangeBus,
    { provide: ViewChangeBus, useExisting: RedisViewChangeBus },

    // Application layer.
    ProjectTrackingEvent,
    GetTrackingView,
    WatchTrackingView,
    GetOrderRoute,

    // Inbound Kafka adapter.
    TrackingEventsConsumer,
  ],
})
export class TrackingQueryServiceModule {}
