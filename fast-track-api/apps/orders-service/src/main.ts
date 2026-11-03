import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
<<<<<<< HEAD
import { initObservability, setupHttpObservability } from '@libs/observability';
=======
import {
  createValidationPipe,
  ProblemDetailsFilter,
  setupSwagger,
} from '@libs/http';
>>>>>>> 61161971f5f5dbc3acabb1b235fc1aaeb2715aa6
import { OrdersServiceModule } from './orders-service.module.js';
import { buildOrdersOpenApi, SWAGGER_PATH } from './openapi.js';

async function bootstrap() {
<<<<<<< HEAD
  // JSON logs, Prometheus metrics and traces (libs/observability).
  const { logger } = initObservability('orders-service');
  const app = await NestFactory.create(OrdersServiceModule, { logger });
  setupHttpObservability(app);
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
=======
  const app = await NestFactory.create(OrdersServiceModule);
  // Kong forwards the full path, /v1 included (strip_path: false in deploy/kong/kong.yml).
  app.setGlobalPrefix('v1');
  // Every error leaves as application/problem+json (spec 2).
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Validates bodies, query and params against their DTOs; invalid or unknown fields -> 400.
  app.useGlobalPipes(createValidationPipe());
  // Swagger UI at /v1/orders/docs (disable with SWAGGER_ENABLED=false).
  if (process.env.SWAGGER_ENABLED !== 'false') {
    setupSwagger(app, SWAGGER_PATH, buildOrdersOpenApi(app));
  }
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so Kafka, the outbox relay,
  // the cleanup scheduler and the database stop cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}

/**
 * `--openapi <file>`: writes the OpenAPI document and exits, without
 * connecting to the database or Kafka. Preview mode builds the module graph
 * (controllers and their metadata) but does not instantiate providers.
 */
async function exportOpenApi(file: string) {
  const app = await NestFactory.create(OrdersServiceModule, {
    preview: true,
    logger: false,
  });
  app.setGlobalPrefix('v1');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildOrdersOpenApi(app), null, 2)}\n`);
  console.log(`OpenAPI document written to ${file}`);
}

const openApiFlag = process.argv.indexOf('--openapi');
if (openApiFlag >= 0) {
  await exportOpenApi(process.argv[openApiFlag + 1] ?? 'openapi.json');
} else {
  await bootstrap();
>>>>>>> 61161971f5f5dbc3acabb1b235fc1aaeb2715aa6
}
