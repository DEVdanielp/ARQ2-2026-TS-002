import { NestFactory } from '@nestjs/core';
import { GpsTrackingWorkerModule } from './gps-tracking-worker.module.js';

async function bootstrap() {
  const app = await NestFactory.create(GpsTrackingWorkerModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so Kafka clients disconnect cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
