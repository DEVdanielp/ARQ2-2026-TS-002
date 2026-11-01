/**
 * REST API of drivers (spec 4.1), behind Kong at `/v1/drivers/...`.
 * (`POST /v1/drivers/me/locations` is routed by Kong to the GPS Ingestion API,
 * not here.)
 *
 * An INBOUND ADAPTER (ADR-014): no business rules here.
 */
import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AuthGuard,
  CurrentUser,
  RequireRoles,
  Roles,
  type AuthenticatedUser,
} from '@libs/auth';
import { ApiProblemResponses } from '@libs/http';
import {
  ChangeDriverAvailability,
  ChangeDriverCapacity,
  SaveDriverProfile,
} from '../../../application/driver-profile.use-cases.js';
import {
  ChangeAvailabilityDto,
  ChangeCapacityDto,
  DriverDto,
  SaveDriverProfileDto,
} from './dtos.js';
import { asHttp, correlationIdFrom } from './http-errors.js';
import { problemExample } from './openapi-examples.js';
import { driverView } from './views.js';

const DRIVER_EXAMPLE = {
  driverId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  name: 'Carlos Ruiz',
  phone: '+573109876543',
  vehiclePlate: 'ABC123',
};

@ApiTags('Drivers')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('drivers')
@UseGuards(AuthGuard)
export class DriversController {
  constructor(
    private readonly saveProfile: SaveDriverProfile,
    private readonly changeAvailability: ChangeDriverAvailability,
    private readonly changeCapacity: ChangeDriverCapacity,
  ) {}

  @Put('me')
  @RequireRoles(Roles.DRIVER)
  @ApiOperation({
    summary: "Create or update the caller's driver profile",
    description:
      'Role `DRIVER`. The driver is always the JWT `sub`. Returns `201` when created and `200` when updated. ' +
      'A new driver starts `OFFLINE` with capacity 3 (configurable); availability and capacity are changed ' +
      'with their own endpoints and are not touched here.',
  })
  @ApiCreatedResponse({
    type: DriverDto,
    description: 'Profile created',
    example: {
      ...DRIVER_EXAMPLE,
      availability: 'OFFLINE',
      capacity: 3,
      activeOrderIds: [],
    },
  })
  @ApiOkResponse({ type: DriverDto, description: 'Profile updated' })
  @ApiProblemResponses(400)
  async put(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveDriverProfileDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DriverDto> {
    const { driver, created } = await asHttp(() =>
      this.saveProfile.execute(user.userId, {
        name: body.name,
        phone: body.phone,
        vehiclePlate: body.vehiclePlate,
      }),
    );
    response.status(created ? 201 : 200);
    return driverView(driver);
  }

  @Patch('me/availability')
  @RequireRoles(Roles.DRIVER)
  @ApiOperation({
    summary: "Change the caller's availability (AVAILABLE / OFFLINE)",
    description:
      'Role `DRIVER`. `EN_ROUTE` is set by the system: an `AVAILABLE` driver with active orders is shown as `EN_ROUTE` ' +
      'and can still receive orders while they have a free slot.\n\n' +
      '- `AVAILABLE`: orders waiting for a driver can be assigned to them at their next attempt (every 30 s).\n' +
      '- `OFFLINE`: refused with `409` while one of their orders is `ON_THE_WAY`. Every order still `CREATED` is released: ' +
      '`DriverUnassigned` is published (`assignment.events`, reason `DRIVER_OFFLINE`) and its assignment restarts with a new ' +
      '10-minute window, ending in `DriverAssigned` or `AssignmentFailed` (F1-S6, saga compensation).',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Added by Kong; copied into the events',
  })
  @ApiOkResponse({
    type: DriverDto,
    example: {
      ...DRIVER_EXAMPLE,
      availability: 'AVAILABLE',
      capacity: 3,
      activeOrderIds: [],
    },
  })
  @ApiResponse(
    problemExample(400, 'Invalid value (EN_ROUTE cannot be requested)', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: '/v1/drivers/me/availability',
      errors: [
        {
          field: 'availability',
          message:
            'availability must be AVAILABLE or OFFLINE (EN_ROUTE is set by the system)',
        },
      ],
    }),
  )
  @ApiResponse(
    problemExample(
      404,
      'The driver profile does not exist (use PUT /drivers/me)',
      {
        type: 'not-found',
        title: 'Not Found',
        detail: 'Driver profile not created yet',
        instance: '/v1/drivers/me/availability',
      },
    ),
  )
  @ApiResponse(
    problemExample(409, 'Cannot go OFFLINE with orders ON_THE_WAY', {
      type: 'orders-on-the-way',
      title: 'Driver has orders on the way',
      detail:
        'Cannot go OFFLINE with orders ON_THE_WAY: 6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10.',
      instance: '/v1/drivers/me/availability',
    }),
  )
  async patchAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChangeAvailabilityDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<DriverDto> {
    return driverView(
      await asHttp(() =>
        this.changeAvailability.execute(
          user.userId,
          body.availability,
          correlationIdFrom(correlationId),
        ),
      ),
    );
  }

  @Patch(':driverId/capacity')
  @RequireRoles(Roles.OPERATIONS)
  @ApiOperation({
    summary: "Change a driver's capacity (max concurrent orders)",
    description:
      "Role `OPERATIONS`. Capacity 1–10, never lower than the driver's current active orders (`409`). " +
      'A higher capacity lets waiting orders be assigned to the driver at their next attempt.',
  })
  @ApiParam({ name: 'driverId', format: 'uuid' })
  @ApiOkResponse({
    type: DriverDto,
    example: {
      ...DRIVER_EXAMPLE,
      availability: 'EN_ROUTE',
      capacity: 4,
      activeOrderIds: ['6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10'],
    },
  })
  @ApiResponse(
    problemExample(400, 'Capacity out of range (1–10) or invalid driverId', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: '/v1/drivers/9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d/capacity',
      errors: [
        { field: 'capacity', message: 'capacity must not be greater than 10' },
      ],
    }),
  )
  @ApiResponse(
    problemExample(404, 'Unknown driver', {
      type: 'not-found',
      title: 'Not Found',
      detail: 'Driver 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d not found',
      instance: '/v1/drivers/9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d/capacity',
    }),
  )
  @ApiResponse(
    problemExample(
      409,
      "Capacity lower than the driver's current active orders",
      {
        type: 'capacity-below-active-orders',
        title: 'Capacity lower than active orders',
        detail: 'Driver has 2 active orders; capacity 1 is not allowed.',
        instance: '/v1/drivers/9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d/capacity',
      },
    ),
  )
  async patchCapacity(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() body: ChangeCapacityDto,
  ): Promise<DriverDto> {
    return driverView(
      await asHttp(() => this.changeCapacity.execute(driverId, body.capacity)),
    );
  }
}
