import { Controller, Get } from '@nestjs/common';
import { GpsIngestionApiService } from './gps-ingestion-api.service.js';

@Controller()
export class GpsIngestionApiController {
  constructor(private readonly gpsIngestionApiService: GpsIngestionApiService) {}

  @Get()
  getHello(): string {
    return this.gpsIngestionApiService.getHello();
  }
}
