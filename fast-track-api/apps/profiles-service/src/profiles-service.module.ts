import { Module } from '@nestjs/common';
import { ProfilesServiceController } from './profiles-service.controller.js';
import { ProfilesServiceService } from './profiles-service.service.js';

@Module({
  imports: [],
  controllers: [ProfilesServiceController],
  providers: [ProfilesServiceService],
})
export class ProfilesServiceModule {}
