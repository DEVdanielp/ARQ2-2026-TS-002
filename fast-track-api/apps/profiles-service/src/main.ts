import { NestFactory } from '@nestjs/core';
import { ProfilesServiceModule } from './profiles-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ProfilesServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
