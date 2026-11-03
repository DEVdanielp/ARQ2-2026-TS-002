/**
 * Request and response shapes of the REST API (spec 4.2, spec 3 schemas).
 *
 * - class-validator decorators: validated by the global ValidationPipe
 *   (`@libs/http` createValidationPipe); invalid or unknown fields -> 400, so
 *   a client can never send `customerId` (identity comes from the JWT).
 * - @ApiProperty decorators: describe the same shapes in the OpenAPI
 *   (Swagger) document, so the docs cannot drift from what is validated.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  Actors,
  IntentTypes,
  MAX_ADDRESS_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REASON_LENGTH,
  OrderStatuses,
  type Actor,
  type IntentType,
  type OrderStatus,
} from '../../../domain/order.js';

const ORDER_ID = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
const MAX_PAGE_SIZE = 100;

/** Spec 3 `Location` (WGS-84). */
export class LocationDto {
  @ApiProperty({ minimum: -90, maximum: 90, example: 6.2088, format: 'double' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({
    minimum: -180,
    maximum: 180,
    example: -75.5679,
    format: 'double',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng: number;
}

/** Spec 3 `Destination`. */
export class DestinationDto {
  @ApiProperty({
    example: 'Cra 43A #1-50, Medellín',
    maxLength: MAX_ADDRESS_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LENGTH)
  address: string;

  @ApiProperty({ type: () => LocationDto })
  @ValidateNested()
  @Type(() => LocationDto)
  @IsNotEmpty()
  location: LocationDto;
}

/** Body of `POST /orders`. */
export class CreateOrderDto {
  @ApiProperty({ type: () => DestinationDto })
  @ValidateNested()
  @Type(() => DestinationDto)
  @IsNotEmpty()
  destination: DestinationDto;

  @ApiPropertyOptional({
    example: 'Leave at reception',
    maxLength: MAX_NOTES_LENGTH,
    description: 'Stored with the order; not returned in `Order`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string;
}

/** Query of `GET /orders`. */
export class ListOrdersQueryDto {
  @ApiPropertyOptional({ enum: OrderStatuses, example: 'ON_THE_WAY' })
  @IsOptional()
  @IsIn(OrderStatuses)
  status?: OrderStatus;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Starts at 0' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page: number = 0;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  size: number = 20;
}

/** Body of `POST /orders/{orderId}/intents`. */
export class SubmitIntentDto {
  @ApiProperty({ enum: IntentTypes, example: 'CANCELLATION_REQUESTED' })
  @IsIn(IntentTypes)
  type: IntentType;

  @ApiPropertyOptional({
    example: 'Failed delivery: recipient unreachable',
    maxLength: MAX_REASON_LENGTH,
    description: 'Required when the caller is `OPERATIONS`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASON_LENGTH)
  reason?: string;
}

/** `cancellation` of spec 3 `Order`. */
export class CancellationDto {
  @ApiProperty({ enum: Actors, example: 'OPERATIONS' })
  actor: Actor;

  @ApiPropertyOptional({
    example: 'Failed delivery: recipient unreachable',
    maxLength: MAX_REASON_LENGTH,
  })
  reason?: string;
}

/** Spec 3 `Order`. */
export class OrderDto {
  @ApiProperty({ format: 'uuid', example: ORDER_ID })
  orderId: string;

  @ApiProperty({
    format: 'uuid',
    example: '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10',
    description: 'The JWT sub of the customer who created it',
  })
  customerId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Null until a driver is assigned',
  })
  driverId: string | null;

  @ApiProperty({ type: () => DestinationDto })
  destination: DestinationDto;

  @ApiProperty({ enum: OrderStatuses, example: 'CREATED' })
  status: OrderStatus;

  @ApiProperty({
    minimum: 1,
    example: 1,
    description:
      'Increases on every change, including a driver being assigned or released',
  })
  version: number;

  @ApiProperty({ type: () => CancellationDto, nullable: true, example: null })
  cancellation: CancellationDto | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:01:00Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:01:00Z' })
  updatedAt: string;
}

/** Response of `GET /orders`. */
export class OrderPageDto {
  @ApiProperty({ type: () => [OrderDto] })
  items: OrderDto[];

  @ApiProperty({ example: 0 })
  page: number;

  @ApiProperty({ example: 20 })
  size: number;

  @ApiProperty({ example: 1, description: 'Orders matching the filter' })
  total: number;
}

/** Response of `POST /orders/{orderId}/intents`. */
export class IntentAcceptedDto {
  @ApiProperty({
    format: 'uuid',
    example: 'c2d4e6f8-0a1b-4c3d-9e5f-7a8b9c0d1e2f',
  })
  intentId: string;

  @ApiProperty({ format: 'uuid', example: ORDER_ID })
  orderId: string;

  @ApiProperty({ enum: IntentTypes, example: 'CANCELLATION_REQUESTED' })
  type: IntentType;

  @ApiProperty({
    enum: ['QUEUED'],
    example: 'QUEUED',
    description: 'Accepted for processing; not applied yet',
  })
  status: 'QUEUED';
}
