import { Module } from '@nestjs/common';
import { GpsTrackingWorkerController } from './gps-tracking-worker.controller.js';
import { GpsTrackingWorkerService } from './gps-tracking-worker.service.js';

@Module({
  imports: [],
  controllers: [GpsTrackingWorkerController],
  providers: [GpsTrackingWorkerService],
})
export class GpsTrackingWorkerModule {}
