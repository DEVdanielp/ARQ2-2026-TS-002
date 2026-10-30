import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createValidationPipe, ProblemDetailsFilter, setupSwagger } from '@libs/http';
import { NotificationServiceModule } from './notification-service.module.js';
import { buildNotificationOpenApi, SWAGGER_PATH } from './openapi.js';

async function bootstrap() {
  const app = await NestFactory.create(NotificationServiceModule);
  // Kong forwards the full path, /v1 included (strip_path: false in deploy/kong/kong.yml).
  app.setGlobalPrefix('v1');
  // Every error leaves as application/problem+json (spec 2).
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Validates request bodies against their DTOs; invalid or unknown fields -> 400.
  app.useGlobalPipes(createValidationPipe());
  // Swagger UI at /v1/notifications/docs (disable with SWAGGER_ENABLED=false).
  if (process.env.SWAGGER_ENABLED !== 'false') {
    setupSwagger(app, SWAGGER_PATH, buildNotificationOpenApi(app));
  }
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so Kafka, the outbox relay and
  // the database stop cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}

/**
 * `--openapi <file>`: writes the OpenAPI document and exits, without
 * connecting to the database or Kafka. Preview mode builds the module graph
 * (controllers and their metadata) but does not instantiate providers.
 */
async function exportOpenApi(file: string) {
  const app = await NestFactory.create(NotificationServiceModule, { preview: true, logger: false });
  app.setGlobalPrefix('v1');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildNotificationOpenApi(app), null, 2)}\n`);
  console.log(`OpenAPI document written to ${file}`);
}

const openApiFlag = process.argv.indexOf('--openapi');
if (openApiFlag >= 0) {
  await exportOpenApi(process.argv[openApiFlag + 1] ?? 'openapi.json');
} else {
  await bootstrap();
}
