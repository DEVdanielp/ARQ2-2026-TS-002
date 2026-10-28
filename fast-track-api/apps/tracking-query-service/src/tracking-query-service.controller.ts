import { Controller, Get } from '@nestjs/common';
import { TrackingQueryServiceService } from './tracking-query-service.service.js';

@Controller()
export class TrackingQueryServiceController {
  constructor(private readonly trackingQueryServiceService: TrackingQueryServiceService) {}

  @Get()
  getHello(): string {
    return this.trackingQueryServiceService.getHello();
  }
}
