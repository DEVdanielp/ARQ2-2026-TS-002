import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { initObservability, setupHttpObservability } from '@libs/observability';
import { createValidationPipe, ProblemDetailsFilter, setupSwagger } from '@libs/http';
import { TrackingQueryServiceModule } from './tracking-query-service.module.js';
import { buildTrackingOpenApi, SWAGGER_PATH } from './openapi.js';

async function bootstrap() {
  // JSON logs, Prometheus metrics and traces (libs/observability).
  const { logger } = initObservability('tracking-query-service');
  const app = await NestFactory.create(TrackingQueryServiceModule, { logger });
  setupHttpObservability(app);
  // Kong forwards the full path, /v1 included (strip_path: false in deploy/kong/kong.yml).
  app.setGlobalPrefix('v1');
  // Every error leaves as application/problem+json (spec 2).
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(createValidationPipe());
  // Swagger UI at /v1/tracking/docs (disable with SWAGGER_ENABLED=false).
  if (process.env.SWAGGER_ENABLED !== 'false') {
    setupSwagger(app, SWAGGER_PATH, buildTrackingOpenApi(app));
  }
  // Run shutdown hooks on SIGTERM/SIGINT so Kafka, Redis and the database stop cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}

/**
 * `--openapi <file>`: writes the OpenAPI document and exits, without
 * connecting to Redis, the database or Kafka. Preview mode builds the module
 * graph (controllers and their metadata) but does not instantiate providers.
 */
async function exportOpenApi(file: string) {
  const app = await NestFactory.create(TrackingQueryServiceModule, { preview: true, logger: false });
  app.setGlobalPrefix('v1');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildTrackingOpenApi(app), null, 2)}\n`);
  console.log(`OpenAPI document written to ${file}`);
}

const openApiFlag = process.argv.indexOf('--openapi');
if (openApiFlag >= 0) {
  await exportOpenApi(process.argv[openApiFlag + 1] ?? 'openapi.json');
} else {
  await bootstrap();
}
