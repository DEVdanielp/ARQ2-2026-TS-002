// DEMO: remove when the real use case is implemented
/**
 * Temporary endpoint that publishes a sample `GpsBatchReceived` event to
 * `gps.batches`, to check the Kafka wiring end to end before the real
 * `POST /drivers/me/locations` (spec 4.3) exists.
 *
 *   POST /demo/gps-batch?driverId=<uuid>     (driverId optional)
 *
 * It skips everything the real endpoint must do (JWT, validation, 50-point
 * limit) and only shows how a service builds an envelope and publishes it.
 */
import { Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createEnvelope, Topics } from '@libs/events';
import { KafkaProducerService } from '@libs/kafka';

@Controller('demo')
export class DemoGpsBatchController {
  constructor(private readonly producer: KafkaProducerService) {}

  @Post('gps-batch')
  @HttpCode(202)
  async publishSampleBatch(
    @Query('driverId') driverIdParam?: string,
    @Headers('x-correlation-id') correlationIdHeader?: string,
  ) {
    const driverId = driverIdParam || randomUUID();
    const batchId = randomUUID();
    const now = new Date().toISOString();

    // Payload shape from spec 5.4 (GpsBatchReceived).
    const envelope = createEnvelope({
      eventType: 'GpsBatchReceived',
      schemaVersion: 1,
      producer: 'gps-ingestion-api',
      // Kong adds X-Correlation-Id in front of the real API; generate one when
      // calling the service directly.
      correlationId: correlationIdHeader || randomUUID(),
      aggregateId: driverId,
      aggregateVersion: null,
      payload: {
        driverId,
        batchId,
        receivedAt: now,
        points: [
          { lat: 6.2442, lng: -75.5812, deviceTime: now, sequence: 1041 },
          { lat: 6.2439, lng: -75.5807, deviceTime: now, sequence: 1042 },
        ],
      },
    });

    // Key = driverId: all batches of a driver go to the same partition and are
    // processed in order (spec 5.1, ADR-001).
    const result = await this.producer.publish(Topics.GPS_BATCHES, driverId, envelope);

    return { batchId, accepted: envelope.payload.points.length, eventId: envelope.eventId, ...result };
  }
}
