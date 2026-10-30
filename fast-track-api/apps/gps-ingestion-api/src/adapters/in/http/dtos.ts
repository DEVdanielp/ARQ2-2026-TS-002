/**
 * Request and response shapes of `POST /drivers/me/locations` (spec 4.3,
 * schemas `GpsPoint` and `PointBatch` of spec 3).
 *
 * - class-validator decorators: validated by the global ValidationPipe
 *   (`@libs/http` createValidationPipe); invalid or unknown fields -> 400.
 *   Unknown fields include `driverId`: the driver always comes from the JWT.
 * - @ApiProperty decorators: describe the same shapes in the OpenAPI
 *   (Swagger) document, so the docs cannot drift from what is validated.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  isRFC3339,
  Max,
  Min,
  ValidateBy,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import { GPS_BATCH_MAX_POINTS, GPS_BATCH_MIN_POINTS } from '@libs/events';

const FINITE = { allowNaN: false, allowInfinity: false };

/**
 * An RFC 3339 date-time with an explicit offset (`Z` or `±hh:mm`) that is also
 * a real instant (rejects `2026-02-30T...`). Spec 2: times are ISO-8601 UTC;
 * GPS points carry the device time.
 */
function IsDeviceTime(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDeviceTime',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isRFC3339(value) && !Number.isNaN(Date.parse(value)) && isRealDate(value),
        defaultMessage: () => '$property must be an ISO-8601 date-time with a time zone, e.g. 2026-10-18T15:20:01Z',
      },
    },
    options,
  );
}

/** `Date.parse` rolls 2026-02-30 over to March; compare the calendar date back. */
function isRealDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

/** Spec 3 `GpsPoint`. */
export class GpsPointDto {
  @ApiProperty({ format: 'double', minimum: -90, maximum: 90, example: 6.2442, description: 'Latitude, WGS-84' })
  @IsNumber(FINITE)
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ format: 'double', minimum: -180, maximum: 180, example: -75.5812, description: 'Longitude, WGS-84' })
  @IsNumber(FINITE)
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-18T15:20:01Z',
    description: 'Time measured by the DEVICE, with a time zone. Stored and published in UTC.',
  })
  @IsDeviceTime()
  deviceTime: string;

  @ApiProperty({
    type: 'integer',
    format: 'int64',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    example: 1041,
    description:
      'Monotonic per driver device. The worker processes points by sequence and ignores sequences it already ' +
      'processed, so a retried batch never duplicates history (values above 2^53 - 1 are rejected).',
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence: number;

  @ApiPropertyOptional({ minimum: 0, example: 8, description: 'GPS accuracy in metres' })
  @IsOptional()
  @IsNumber(FINITE)
  @Min(0)
  accuracyMeters?: number;

  @ApiPropertyOptional({ minimum: 0, example: 32.5, description: 'Speed in km/h' })
  @IsOptional()
  @IsNumber(FINITE)
  @Min(0)
  speedKmh?: number;
}

const BATCH_SIZE_MESSAGE = `A batch must contain between ${GPS_BATCH_MIN_POINTS} and ${GPS_BATCH_MAX_POINTS} points`;

/** Spec 3 `PointBatch` (request body). */
export class PointBatchDto {
  @ApiProperty({
    type: [GpsPointDto],
    minItems: GPS_BATCH_MIN_POINTS,
    maxItems: GPS_BATCH_MAX_POINTS,
    description:
      'Between 1 and 50 points, in any order (e.g. the backlog accumulated without signal). ' +
      'The worker sorts them by sequence.',
  })
  @IsArray()
  @ArrayMinSize(GPS_BATCH_MIN_POINTS, { message: BATCH_SIZE_MESSAGE })
  @ArrayMaxSize(GPS_BATCH_MAX_POINTS, { message: BATCH_SIZE_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => GpsPointDto)
  points: GpsPointDto[];
}

/** Response of `202 Accepted`. */
export class BatchAcceptedDto {
  @ApiProperty({ format: 'uuid', example: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', description: 'Id given to this batch' })
  batchId: string;

  @ApiProperty({ example: 2, description: 'Number of points published for processing' })
  accepted: number;
}
