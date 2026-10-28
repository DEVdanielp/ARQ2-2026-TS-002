import { NestFactory } from '@nestjs/core';
import { OrdersServiceModule } from './orders-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(OrdersServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
