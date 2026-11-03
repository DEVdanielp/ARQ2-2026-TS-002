/**
 * Response shapes of the REST API (spec 3 `TrackingView`, `RoutePoint`;
 * spec 4.4). Only for the OpenAPI (Swagger) document: the API has no request
 * bodies. Every field is declared with @ApiProperty because the Nest CLI
 * Swagger plugin does not run under rspack.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatuses, IntentTypes, OrderStatuses } from '../../../domain/tracking-view.js';

export class LocationDto {
  @ApiProperty({ example: 6.2439, minimum: -90, maximum: 90 })
  lat: number;

  @ApiProperty({ example: -75.5807, minimum: -180, maximum: 180 })
  lng: number;
}

export class DestinationDto {
  @ApiPropertyOptional({ example: 'Cra 43A #1-50, Medellín', maxLength: 300 })
  address?: string;

  @ApiProperty({ type: LocationDto })
  location: LocationDto;
}

export class RejectedIntentDto {
  @ApiProperty({ enum: IntentTypes })
  type: string;

  @ApiProperty({ example: 'Order is DELIVERED' })
  reason: string;

  @ApiProperty({ format: 'date-time' })
  at: string;
}

/** Spec 3 `TrackingView`. */
export class TrackingViewDto {
  @ApiProperty({ format: 'uuid', example: '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10' })
  orderId: string;

  @ApiProperty({ enum: OrderStatuses, example: 'ON_THE_WAY', description: 'Never changed by a stale location' })
  status: string;

  @ApiProperty({ example: 3, description: 'Order version (aggregateVersion of the last status event)' })
  version: number;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, example: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' })
  driverId: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Carlos Ruiz' })
  driverName: string | null;

  @ApiProperty({
    enum: AssignmentStatuses,
    example: 'ASSIGNED',
    description: 'PENDING while looking for a driver; FAILED after AssignmentFailed',
  })
  assignmentStatus: string;

  @ApiProperty({ type: DestinationDto, nullable: true })
  destination: DestinationDto | null;

  @ApiProperty({ type: LocationDto, nullable: true })
  lastLocation: LocationDto | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String, example: '2026-10-18T15:20:06Z' })
  lastLocationDeviceTime: string | null;

  @ApiProperty({ nullable: true, type: Number, example: 1042 })
  lastSequence: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 240, description: 'Computed at read time from lastLocationDeviceTime' })
  locationAgeSeconds: number | null;

  @ApiProperty({
    example: true,
    description: 'false when there is no location or it is 300 s old or more ("Tracking temporarily unavailable")',
  })
  trackingAvailable: boolean;

  @ApiProperty({ example: false, description: 'true once DriverNearDestination was received' })
  nearbyReached: boolean;

  @ApiProperty({ type: RejectedIntentDto, nullable: true })
  lastRejectedIntent: RejectedIntentDto | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:20:07Z' })
  updatedAt: string;
}

/** Spec 3 `RoutePoint`. */
export class RoutePointDto {
  @ApiProperty({ example: 6.2442 })
  lat: number;

  @ApiProperty({ example: -75.5812 })
  lng: number;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:20:01Z' })
  deviceTime: string;

  @ApiProperty({ example: 1041 })
  sequence: number;
}

export class OrderRouteDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  driverId: string | null;

  @ApiProperty({ type: [RoutePointDto], description: 'Ordered by sequence' })
  points: RoutePointDto[];
}
