import { Module } from '@nestjs/common';
import { KafkaModule } from '@libs/kafka';
import { GpsTrackingWorkerController } from './gps-tracking-worker.controller.js';
import { GpsTrackingWorkerService } from './gps-tracking-worker.service.js';
import { DemoGpsBatchesConsumer } from './demo-gps-batches.consumer.js'; // DEMO: remove when the real use case is implemented

@Module({
  imports: [KafkaModule.forRoot({ clientId: 'gps-tracking-worker' })],
  controllers: [GpsTrackingWorkerController],
  providers: [
    GpsTrackingWorkerService,
    DemoGpsBatchesConsumer, // DEMO: remove when the real use case is implemented
  ],
})
export class GpsTrackingWorkerModule {}
