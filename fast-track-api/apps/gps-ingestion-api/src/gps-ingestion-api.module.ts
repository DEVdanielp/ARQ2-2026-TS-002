import { Module } from '@nestjs/common';
import { KafkaModule } from '@libs/kafka';
import { GpsIngestionApiController } from './gps-ingestion-api.controller.js';
import { GpsIngestionApiService } from './gps-ingestion-api.service.js';
import { DemoGpsBatchController } from './demo-gps-batch.controller.js'; // DEMO: remove when the real use case is implemented

@Module({
  imports: [KafkaModule.forRoot({ clientId: 'gps-ingestion-api' })],
  controllers: [
    GpsIngestionApiController,
    DemoGpsBatchController, // DEMO: remove when the real use case is implemented
  ],
  providers: [GpsIngestionApiService],
})
export class GpsIngestionApiModule {}
