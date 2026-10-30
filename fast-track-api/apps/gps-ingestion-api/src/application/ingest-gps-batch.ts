/**
 * IngestGpsBatch: the only use case of the GPS Ingestion API (F2-S1, F2-S2).
 *
 *   1. Give the batch an id and stamp the server reception time.
 *   2. Wrap it in a `GpsBatchReceived` envelope whose aggregate is the driver.
 *   3. Publish it to `gps.batches` keyed by driverId, so every batch of one
 *      driver lands in the same partition and is processed in order (ADR-001).
 *
 * It never processes the points: no sorting, no deduplication, no storage.
 * That is the GPS Tracking Worker's job; this keeps the request fast and the
 * service stateless. Validation (1–50 points, coordinates, times) happens
 * before this use case, in the HTTP adapter.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createEnvelope,
  GPS_BATCH_RECEIVED,
  GPS_BATCH_RECEIVED_SCHEMA_VERSION,
  type GpsBatchReceivedPayload,
  type GpsPoint,
} from '@libs/events';
import { GpsBatchPublisher } from './ports.js';

export const PRODUCER_NAME = 'gps-ingestion-api';

export interface IngestGpsBatchCommand {
  /** The JWT `sub` of the caller; never taken from the body (spec 2, Identity). */
  driverId: string;
  /** Already validated points, in the order the app sent them. */
  points: GpsPoint[];
  /** From `X-Correlation-Id` (added by Kong). */
  correlationId: string;
}

export interface IngestGpsBatchResult {
  batchId: string;
  /** Number of points published. */
  accepted: number;
}

@Injectable()
export class IngestGpsBatch {
  private readonly logger = new Logger(IngestGpsBatch.name);

  constructor(private readonly publisher: GpsBatchPublisher) {}

  async execute(command: IngestGpsBatchCommand): Promise<IngestGpsBatchResult> {
    const { driverId, points, correlationId } = command;
    const batchId = randomUUID();

    const envelope = createEnvelope<GpsBatchReceivedPayload>({
      eventType: GPS_BATCH_RECEIVED,
      schemaVersion: GPS_BATCH_RECEIVED_SCHEMA_VERSION,
      producer: PRODUCER_NAME,
      correlationId,
      aggregateId: driverId,
      aggregateVersion: null,
      payload: { driverId, batchId, receivedAt: new Date().toISOString(), points },
    });

    await this.publisher.publish(envelope);

    this.logger.log({
      msg: 'GPS batch accepted',
      driverId,
      batchId,
      points: points.length,
      eventId: envelope.eventId,
      correlationId,
    });
    return { batchId, accepted: points.length };
  }
}
