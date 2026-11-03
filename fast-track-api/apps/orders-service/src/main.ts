import { NestFactory } from '@nestjs/core';
import { initObservability, setupHttpObservability } from '@libs/observability';
import { OrdersServiceModule } from './orders-service.module.js';

async function bootstrap() {
  // JSON logs, Prometheus metrics and traces (libs/observability).
  const { logger } = initObservability('orders-service');
  const app = await NestFactory.create(OrdersServiceModule, { logger });
  setupHttpObservability(app);
  await app.listen(process.env.PORT ?? process.env.port ?? 3000);
}
await bootstrap();
