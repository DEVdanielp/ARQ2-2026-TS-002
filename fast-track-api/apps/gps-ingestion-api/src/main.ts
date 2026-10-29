import { NestFactory } from '@nestjs/core';
import { GpsIngestionApiModule } from './gps-ingestion-api.module.js';

async function bootstrap() {
  const app = await NestFactory.create(GpsIngestionApiModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so Kafka clients disconnect cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
