import { Module } from '@nestjs/common';
import { GpsIngestionApiController } from './gps-ingestion-api.controller.js';
import { GpsIngestionApiService } from './gps-ingestion-api.service.js';

@Module({
  imports: [],
  controllers: [GpsIngestionApiController],
  providers: [GpsIngestionApiService],
})
export class GpsIngestionApiModule {}
