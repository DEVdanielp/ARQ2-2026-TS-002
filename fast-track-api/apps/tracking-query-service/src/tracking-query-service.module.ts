import { Module } from '@nestjs/common';
import { TrackingQueryServiceController } from './tracking-query-service.controller.js';
import { TrackingQueryServiceService } from './tracking-query-service.service.js';

@Module({
  imports: [],
  controllers: [TrackingQueryServiceController],
  providers: [TrackingQueryServiceService],
})
export class TrackingQueryServiceModule {}
