import { NestFactory } from '@nestjs/core';
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';
import { NotificationServiceModule } from './notification-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(NotificationServiceModule);
  // Kong forwards the full path, /v1 included (strip_path: false in deploy/kong/kong.yml).
  app.setGlobalPrefix('v1');
  // Every error leaves as application/problem+json (spec 2).
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Validates request bodies against their DTOs; invalid or unknown fields -> 400.
  app.useGlobalPipes(createValidationPipe());
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so Kafka, the outbox relay and
  // the database stop cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}
await bootstrap();
