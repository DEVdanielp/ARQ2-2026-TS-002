/**
 * Request and response shapes of the REST API (spec 4.1, spec 3 schemas).
 *
 * - class-validator decorators: validated by the global ValidationPipe
 *   (`@libs/http` createValidationPipe); invalid or unknown fields -> 400, so
 *   a client can never send `customerId`/`driverId` (identity comes from the JWT).
 * - @ApiProperty decorators: describe the same shapes in the OpenAPI
 *   (Swagger) document, so the docs cannot drift from what is validated.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DriverAvailabilities,
  MAX_CAPACITY,
  MIN_CAPACITY,
  SelectableAvailabilities,
  type DriverAvailability,
  type SelectableAvailability,
} from '../../../domain/profiles.js';

/** International format, e.g. +573001234567 (spec 3 examples). */
const PHONE = /^\+[1-9]\d{6,14}$/;
const PHONE_MESSAGE =
  'phone must be in international format, e.g. +573001234567';

// ---------------------------------------------------------------- customers

/** Body of `PUT /customers/me`. */
export class SaveCustomerProfileDto {
  @ApiProperty({ example: 'Laura Gómez', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'laura@example.com', format: 'email' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({
    example: '+573001234567',
    pattern: PHONE.source,
    description:
      'International format. PUT replaces the profile: omitted = no phone',
  })
  @IsOptional()
  @Matches(PHONE, { message: PHONE_MESSAGE })
  phone?: string;
}

/** Spec 3 `Customer`. */
export class CustomerDto {
  @ApiProperty({
    format: 'uuid',
    example: '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10',
    description: 'Equals the JWT sub',
  })
  customerId: string;

  @ApiProperty({ example: 'Laura Gómez' })
  name: string;

  @ApiProperty({ example: 'laura@example.com', format: 'email' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: '+573001234567' })
  phone: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:00:00Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:00:00Z' })
  updatedAt: string;
}

// ---------------------------------------------------------------- drivers

/** Body of `PUT /drivers/me`. */
export class SaveDriverProfileDto {
  @ApiProperty({ example: 'Carlos Ruiz', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '+573109876543', pattern: PHONE.source })
  @Matches(PHONE, { message: PHONE_MESSAGE })
  phone: string;

  @ApiProperty({ example: 'ABC123', maxLength: 16 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  vehiclePlate: string;
}

/** Body of `PATCH /drivers/me/availability`. */
export class ChangeAvailabilityDto {
  @ApiProperty({
    enum: SelectableAvailabilities,
    example: 'AVAILABLE',
    description:
      '`EN_ROUTE` cannot be requested: the system sets it while the driver has active orders',
  })
  @IsIn(SelectableAvailabilities, {
    message:
      'availability must be AVAILABLE or OFFLINE (EN_ROUTE is set by the system)',
  })
  availability: SelectableAvailability;
}

/** Body of `PATCH /drivers/{driverId}/capacity`. */
export class ChangeCapacityDto {
  @ApiProperty({
    minimum: MIN_CAPACITY,
    maximum: MAX_CAPACITY,
    example: 4,
    description: 'Max concurrent orders',
  })
  // No type conversion: only a JSON integer is accepted ("4" or true -> 400).
  @IsInt()
  @Min(MIN_CAPACITY)
  @Max(MAX_CAPACITY)
  capacity: number;
}

/** Spec 3 `Driver`. */
export class DriverDto {
  @ApiProperty({
    format: 'uuid',
    example: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
    description: 'Equals the JWT sub',
  })
  driverId: string;

  @ApiProperty({ example: 'Carlos Ruiz' })
  name: string;

  @ApiProperty({ example: '+573109876543' })
  phone: string;

  @ApiProperty({ example: 'ABC123' })
  vehiclePlate: string;

  @ApiProperty({
    enum: DriverAvailabilities,
    example: 'AVAILABLE',
    description:
      'AVAILABLE = no active orders · EN_ROUTE = has active orders (set by the system) · OFFLINE = receives nothing',
  })
  availability: DriverAvailability;

  @ApiProperty({
    minimum: MIN_CAPACITY,
    maximum: MAX_CAPACITY,
    example: 3,
    description: 'Max concurrent orders',
  })
  capacity: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: [],
    description: 'Orders currently assigned to the driver',
  })
  activeOrderIds: string[];
}

// ---------------------------------------------------------------- assignments

/** Query of `GET /assignments`. */
export class AssignmentQueryDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10',
  })
  @IsUUID()
  orderId: string;
}

/** Response of `GET /assignments` (spec 4.1). */
export class AssignmentDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10',
  })
  orderId: string;

  @ApiProperty({
    format: 'uuid',
    example: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  })
  driverId: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T15:01:10Z' })
  assignedAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'When the driver stopped having the order (delivered, cancelled, or released because the driver went OFFLINE); null while active',
  })
  releasedAt: string | null;
}
