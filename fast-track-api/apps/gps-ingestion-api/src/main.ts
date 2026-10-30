import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { setupSwagger } from '@libs/http';
import { GpsIngestionApiModule } from './gps-ingestion-api.module.js';
import { configureHttp } from './http-setup.js';
import { buildIngestionOpenApi, SWAGGER_PATH } from './openapi.js';

async function bootstrap() {
  // bodyParser: false -> configureHttp registers the JSON parser with its size limit.
  const app = await NestFactory.create<NestExpressApplication>(GpsIngestionApiModule, { bodyParser: false });
  configureHttp(app);
  // Swagger UI at /v1/gps-ingestion/docs (disable with SWAGGER_ENABLED=false).
  if (process.env.SWAGGER_ENABLED !== 'false') {
    setupSwagger(app, SWAGGER_PATH, buildIngestionOpenApi(app));
  }
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the Kafka producer flushes
  // its buffer and disconnects cleanly.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}

/**
 * `--openapi <file>`: writes the OpenAPI document and exits, without
 * connecting to Kafka. Preview mode builds the module graph (controllers and
 * their metadata) but does not instantiate providers.
 */
async function exportOpenApi(file: string) {
  const app = await NestFactory.create(GpsIngestionApiModule, { preview: true, logger: false });
  app.setGlobalPrefix('v1');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildIngestionOpenApi(app), null, 2)}\n`);
  console.log(`OpenAPI document written to ${file}`);
}

const openApiFlag = process.argv.indexOf('--openapi');
if (openApiFlag >= 0) {
  await exportOpenApi(process.argv[openApiFlag + 1] ?? 'openapi.json');
} else {
  await bootstrap();
}
