import { NestFactory } from '@nestjs/core';
import { GpsTrackingWorkerModule } from './gps-tracking-worker.module.js';

/**
 * The worker has no HTTP API: an application context (no HTTP server) runs
 * the migrations, prepares the history partitions, starts the outbox relay and
 * subscribes the Kafka consumers.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(GpsTrackingWorkerModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the consumers leave their
  // group at once (fast rebalance), the outbox relay stops and the database
  // connection closes cleanly.
  app.enableShutdownHooks();
}
await bootstrap();
