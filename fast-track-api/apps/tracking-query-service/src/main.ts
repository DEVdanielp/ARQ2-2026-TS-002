import { NestFactory } from '@nestjs/core';
import { TrackingQueryServiceModule } from './tracking-query-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(TrackingQueryServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
