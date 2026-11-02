import { Module } from '@nestjs/common';
import { OrdersServiceController } from './orders-service.controller.js';
import { OrdersApplicationService } from './application/orders-application.service.js';
import { ORDERS_REPOSITORY } from './application/orders-repository.port.js';
import { PostgresOrdersRepository } from './persistence/postgres-orders.repository.js';
import { ProblemExceptionFilter } from './http/problem-exception.filter.js';
import { APP_FILTER } from '@nestjs/core';
import { JwtAuthGuard } from './http/jwt-auth.guard.js';
import { RolesGuard } from './http/roles.guard.js';
import { OutboxRelayService } from './application/outbox-relay.service.js';
import { OUTBOX_REPOSITORY, EVENT_PUBLISHER } from './application/outbox-port.js';
import { PostgresOutboxRepository } from './persistence/postgres-outbox.repository.js';
import { KafkaEventPublisher } from './persistence/kafka-event.publisher.js';
import { IntentProcessorService } from './application/intent-processor.service.js';
import { STATE_ENGINE_REPOSITORY } from './application/state-engine.port.js';
import { PostgresStateEngineRepository } from './persistence/postgres-state-engine.repository.js';
import { KafkaIntentConsumer } from './persistence/kafka-intent.consumer.js';
import { INTENT_PROCESSOR } from './application/intent-processor.port.js';

@Module({
  imports: [],
  controllers: [OrdersServiceController],
  providers: [
    OrdersApplicationService,
    PostgresOrdersRepository,
    PostgresOutboxRepository,
    KafkaEventPublisher,
    OutboxRelayService,
    IntentProcessorService,
    KafkaIntentConsumer,
    PostgresStateEngineRepository,
    JwtAuthGuard,
    RolesGuard,
    { provide: ORDERS_REPOSITORY, useExisting: PostgresOrdersRepository },
    { provide: OUTBOX_REPOSITORY, useExisting: PostgresOutboxRepository },
    { provide: EVENT_PUBLISHER, useExisting: KafkaEventPublisher },
    { provide: INTENT_PROCESSOR, useExisting: IntentProcessorService },
    {
      provide: STATE_ENGINE_REPOSITORY,
      useExisting: PostgresStateEngineRepository,
    },
    { provide: APP_FILTER, useClass: ProblemExceptionFilter },
  ],
})
export class OrdersServiceModule {}
