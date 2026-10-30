/**
 * REST API of the GPS Ingestion API (spec 4.3), behind Kong at
 * `POST /v1/drivers/me/locations` (the `v1` prefix is set in http-setup.ts).
 *
 * A controller is an INBOUND ADAPTER (ADR-014): it translates HTTP into the
 * use-case call and its result/errors back into HTTP. It holds no business
 * rules. The @Api* decorators produce the Swagger documentation.
 */
import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
  type ApiResponseOptions,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { AuthGuard, CurrentUser, RequireRoles, Roles, type AuthenticatedUser } from '@libs/auth';
import type { GpsPoint } from '@libs/events';
import { ApiProblemResponses, problem } from '@libs/http';
import { IngestGpsBatch, type IngestGpsBatchResult } from '../../../application/ingest-gps-batch.js';
import { EventBusUnavailableError } from '../../../application/ports.js';
import { BatchAcceptedDto, PointBatchDto, type GpsPointDto } from './dtos.js';

/** Request examples shown in Swagger (spec 4.3). */
const REQUEST_EXAMPLES = {
  live: {
    summary: 'Live tracking (spec example)',
    value: {
      points: [
        { lat: 6.2442, lng: -75.5812, deviceTime: '2026-10-18T15:20:01Z', sequence: 1041, accuracyMeters: 8 },
        { lat: 6.2439, lng: -75.5807, deviceTime: '2026-10-18T15:20:06Z', sequence: 1042, accuracyMeters: 7 },
      ],
    },
  },
  backlog: {
    summary: 'Backlog after a tunnel, out of order (the worker sorts it)',
    value: {
      points: [
        { lat: 6.2301, lng: -75.5744, deviceTime: '2026-10-18T15:31:10Z', sequence: 1103, speedKmh: 28 },
        { lat: 6.2310, lng: -75.5751, deviceTime: '2026-10-18T15:31:00Z', sequence: 1101, speedKmh: 30 },
        { lat: 6.2305, lng: -75.5747, deviceTime: '2026-10-18T15:31:05Z', sequence: 1102, speedKmh: 29 },
      ],
    },
  },
  invalid: {
    summary: 'Invalid: latitude out of range (400)',
    value: { points: [{ lat: 91.5, lng: -75.5812, deviceTime: '2026-10-18T15:20:01Z', sequence: 1041 }] },
  },
};

/** A problem+json response with an example body. */
function problemExample(status: number, description: string, example: object): ApiResponseOptions {
  return {
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' }, example } },
  };
}

@ApiTags('GPS')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('drivers/me/locations')
@UseGuards(AuthGuard)
export class LocationsController {
  constructor(private readonly ingestGpsBatch: IngestGpsBatch) {}

  @Post()
  @HttpCode(202)
  @RequireRoles(Roles.DRIVER)
  @ApiOperation({
    summary: 'Send a batch of 1–50 GPS points',
    description:
      'Role `DRIVER`. The driver is always the JWT `sub` (a `driverId` in the body is rejected). The batch is ' +
      'validated and published to Kafka (`gps.batches`, key = driverId) as `GpsBatchReceived`; the response ' +
      'returns as soon as Kafka confirms it, **without processing the points** (F2-S1). The GPS Tracking Worker ' +
      'later processes them strictly by `sequence`: points can arrive in any order, and a retried batch never ' +
      'duplicates history or moves the location backward (F2-S3, F2-S4).\n\n' +
      'Invalid batches (0 or more than 50 points, coordinates out of range, time without zone) return `400` and ' +
      'nothing is published (F2-S2). On `503` the app keeps the batch and retries it unchanged.',
  })
  @ApiHeader({ name: 'X-Correlation-Id', required: false, description: 'Added by Kong; copied into the event' })
  @ApiBody({ type: PointBatchDto, examples: REQUEST_EXAMPLES })
  @ApiAcceptedResponse({
    type: BatchAcceptedDto,
    description: 'Batch published for processing',
    example: { batchId: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', accepted: 2 },
  })
  @ApiResponse(problemExample(400, 'Invalid batch: wrong size, coordinates, time or unknown field (nothing is published)', {
    type: 'https://api.fasttrack.local/errors/validation',
    title: 'Invalid request',
    status: 400,
    detail: 'One or more fields are invalid.',
    instance: '/v1/drivers/me/locations',
    correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
    errors: [
      { field: 'points', message: 'A batch must contain between 1 and 50 points' },
      { field: 'points.3.lat', message: 'lat must not be greater than 90' },
    ],
  }))
  @ApiResponse(problemExample(503, 'Kafka did not confirm the batch: keep it and retry it unchanged', {
    type: 'https://api.fasttrack.local/errors/event-bus-unavailable',
    title: 'Event bus unavailable',
    status: 503,
    detail: 'An unexpected error occurred.',
    instance: '/v1/drivers/me/locations',
    correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
  }))
  @ApiProblemResponses(413, 429)
  async receive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PointBatchDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<IngestGpsBatchResult> {
    try {
      return await this.ingestGpsBatch.execute({
        driverId: user.userId,
        points: body.points.map(toGpsPoint),
        // Kong always adds it; generate one when the service is called directly.
        correlationId: correlationId || randomUUID(),
      });
    } catch (error) {
      if (error instanceof EventBusUnavailableError) {
        // @libs/http replaces the detail of every 5xx with a generic text and
        // logs the cause; the type and title tell the app to retry.
        throw problem(503, { type: 'event-bus-unavailable', title: 'Event bus unavailable' });
      }
      throw error;
    }
  }
}

/**
 * DTO -> event shape: device time normalised to UTC (spec 2, Time) and absent
 * optional fields left out, so the JSON published to Kafka stays minimal.
 */
function toGpsPoint(dto: GpsPointDto): GpsPoint {
  return {
    lat: dto.lat,
    lng: dto.lng,
    deviceTime: new Date(dto.deviceTime).toISOString(),
    sequence: dto.sequence,
    ...(dto.accuracyMeters !== undefined && { accuracyMeters: dto.accuracyMeters }),
    ...(dto.speedKmh !== undefined && { speedKmh: dto.speedKmh }),
  };
}
