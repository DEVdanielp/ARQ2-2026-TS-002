import { Controller, Get } from '@nestjs/common';
import { GpsTrackingWorkerService } from './gps-tracking-worker.service.js';

@Controller()
export class GpsTrackingWorkerController {
  constructor(private readonly gpsTrackingWorkerService: GpsTrackingWorkerService) {}

  @Get()
  getHello(): string {
    return this.gpsTrackingWorkerService.getHello();
  }
}
