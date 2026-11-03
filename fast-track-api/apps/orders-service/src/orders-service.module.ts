/**
 * Root module of the Orders Service (F4): wires every layer together.
 *
 *   adapters/in   (HTTP controller, Kafka consumer, cleanup scheduler)
 *        │ call
 *   application   (use cases + ports)
 *        │ implemented by
 *   adapters/out  (PostgreSQL orders-db + outbox, Kafka intent publisher)
 *
 * This file is the only place that knows which implementation backs each
 * port (ADR-014).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { OutboxModule } from '@libs/outbox';
import { validateEnvironment } from './config/environment.js';
import { OrdersController } from './adapters/in/http/orders.controller.js';
import { OrdersConsumer } from './adapters/in/kafka/orders.consumer.js';
import { PurgeScheduler } from './adapters/in/scheduler/purge.scheduler.js';
import { KafkaIntentPublisher } from './adapters/out/kafka/kafka-intent.publisher.js';
import { PersistenceModule } from './adapters/out/persistence/persistence.module.js';
import {
  CreateOrder,
  GetOrder,
  ListOrders,
  SubmitIntent,
} from './application/orders.use-cases.js';
import { Clock, IntentPublisher, SystemClock } from './application/ports.js';
import {
  ApplyIntent,
  PurgeExpired,
  RecordDriverAssigned,
  RecordDriverUnassigned,
} from './application/state-engine.use-cases.js';

@Module({
  imports: [
    // Must stay FIRST: it loads the .env file into process.env synchronously,
    // and KafkaModule.forRoot() below reads KAFKA_BROKERS from process.env.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the variables come from docker-compose.yml.
      envFilePath: 'apps/orders-service/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'orders-service' }),
    PersistenceModule,
    OutboxModule.forRoot(),
  ],
  controllers: [OrdersController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IntentPublisher, useClass: KafkaIntentPublisher },

    // Application layer.
    CreateOrder,
    GetOrder,
    ListOrders,
    SubmitIntent,
    ApplyIntent,
    RecordDriverAssigned,
    RecordDriverUnassigned,
    PurgeExpired,

    // Inbound adapters driven by Kafka and by time.
    OrdersConsumer,
    PurgeScheduler,
  ],
})
export class OrdersServiceModule {}
