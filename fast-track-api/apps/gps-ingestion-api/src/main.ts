import { NestFactory } from '@nestjs/core';
import { GpsIngestionApiModule } from './gps-ingestion-api.module.js';

async function bootstrap() {
  const app = await NestFactory.create(GpsIngestionApiModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
