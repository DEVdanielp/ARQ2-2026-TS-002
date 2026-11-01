/**
 * Root module of the Profiles & Assignment Service (F1): wires every layer together.
 *
 *   adapters/in   (HTTP controllers, Kafka consumer, retry scheduler)
 *        │ call
 *   application   (use cases + ports)
 *        │ implemented by
 *   adapters/out  (PostgreSQL profiles-db + outbox)
 *
 * This file is the only place that knows which implementation backs each
 * port (ADR-014).
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaModule } from '@libs/kafka';
import { OutboxModule } from '@libs/outbox';
import {
  PROFILES_DEFAULTS,
  validateEnvironment,
  type ProfilesEnvironment,
} from './config/environment.js';
import { AssignmentWindow } from './domain/assignment-window.js';
import { PersistenceModule } from './adapters/out/persistence/persistence.module.js';
import { AssignmentsController } from './adapters/in/http/assignments.controller.js';
import { CustomersController } from './adapters/in/http/customers.controller.js';
import { DriversController } from './adapters/in/http/drivers.controller.js';
import { OrderEventsConsumer } from './adapters/in/kafka/order-events.consumer.js';
import {
  AssignmentRetryScheduler,
  SchedulerSettings,
} from './adapters/in/scheduler/assignment-retry.scheduler.js';
import { AssignmentSettings, Clock, SystemClock } from './application/ports.js';
import {
  Assigner,
  RetryDueAssignments,
  StartAssignment,
  TrackOrderStatus,
} from './application/assignment.use-cases.js';
import {
  GetCustomerProfile,
  SaveCustomerProfile,
} from './application/customer-profile.use-cases.js';
import {
  ChangeDriverAvailability,
  ChangeDriverCapacity,
  GetAssignment,
  SaveDriverProfile,
} from './application/driver-profile.use-cases.js';

type Config = ConfigService<ProfilesEnvironment, true>;

/** Reads an optional numeric variable, falling back to its documented default. */
function setting(config: Config, key: keyof typeof PROFILES_DEFAULTS): number {
  return config.get(key, { infer: true }) ?? PROFILES_DEFAULTS[key];
}

@Module({
  imports: [
    // Must stay FIRST: it loads the .env file into process.env synchronously,
    // and KafkaModule.forRoot() below reads KAFKA_BROKERS from process.env.
    ConfigModule.forRoot({
      isGlobal: true,
      // Only for running on the host; in Docker the variables come from docker-compose.yml.
      envFilePath: 'apps/profiles-service/.env',
      validate: validateEnvironment,
    }),
    KafkaModule.forRoot({ clientId: 'profiles-service' }),
    PersistenceModule,
    OutboxModule.forRoot(),
  ],
  controllers: [CustomersController, DriversController, AssignmentsController],
  providers: [
    // Settings and time.
    {
      provide: AssignmentSettings,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new AssignmentSettings(
          new AssignmentWindow(
            setting(config, 'ASSIGNMENT_RETRY_SECONDS'),
            setting(config, 'ASSIGNMENT_WINDOW_SECONDS'),
          ),
          setting(config, 'DEFAULT_DRIVER_CAPACITY'),
        ),
    },
    {
      provide: SchedulerSettings,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new SchedulerSettings(
          setting(config, 'ASSIGNMENT_SCHEDULER_INTERVAL_MS'),
        ),
    },
    { provide: Clock, useClass: SystemClock },

    // Application layer.
    Assigner,
    StartAssignment,
    RetryDueAssignments,
    TrackOrderStatus,
    GetCustomerProfile,
    SaveCustomerProfile,
    SaveDriverProfile,
    ChangeDriverAvailability,
    ChangeDriverCapacity,
    GetAssignment,

    // Inbound adapters driven by Kafka and by time.
    OrderEventsConsumer,
    AssignmentRetryScheduler,
  ],
})
export class ProfilesServiceModule {}
