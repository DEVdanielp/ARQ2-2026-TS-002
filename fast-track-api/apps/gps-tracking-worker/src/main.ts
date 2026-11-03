import { NestFactory } from '@nestjs/core';
import { initObservability, startMetricsServer } from '@libs/observability';
import { GpsTrackingWorkerModule } from './gps-tracking-worker.module.js';

/**
 * The worker has no HTTP API: an application context (no HTTP server) runs
 * the migrations, prepares the history partitions, starts the outbox relay and
 * subscribes the Kafka consumers. A tiny separate server only answers
 * Prometheus (`GET /metrics`) and `GET /health`.
 */
async function bootstrap() {
  // JSON logs, Prometheus metrics and traces (libs/observability).
  const { logger } = initObservability('gps-tracking-worker');
  const app = await NestFactory.createApplicationContext(GpsTrackingWorkerModule, { logger });
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the consumers leave their
  // group at once (fast rebalance), the outbox relay stops and the database
  // connection closes cleanly.
  app.enableShutdownHooks();
  await startMetricsServer(process.env.PORT ?? process.env.port ?? 3000);
}
await bootstrap();
