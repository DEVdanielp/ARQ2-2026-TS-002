/**
 * REST API of customer profiles (spec 4.1), behind Kong at `/v1/customers/...`
 * (the `v1` prefix is set in main.ts).
 *
 * An INBOUND ADAPTER (ADR-014): translates HTTP into use-case calls and
 * use-case results/errors back into HTTP. No business rules here. The @Api*
 * decorators produce the Swagger documentation.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
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
  GetCustomerProfile,
  SaveCustomerProfile,
} from '../../../application/customer-profile.use-cases.js';
import { CustomerDto, SaveCustomerProfileDto } from './dtos.js';
import { asHttp, correlationIdFrom } from './http-errors.js';
import { problemExample } from './openapi-examples.js';
import { customerView } from './views.js';

@ApiTags('Customers')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('customers')
@UseGuards(AuthGuard)
export class CustomersController {
  constructor(
    private readonly getProfile: GetCustomerProfile,
    private readonly saveProfile: SaveCustomerProfile,
  ) {}

  @Get('me')
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: "Get the caller's customer profile",
    description: 'Role `CUSTOMER`. The customer is the JWT `sub`.',
  })
  @ApiOkResponse({ type: CustomerDto })
  @ApiResponse(
    problemExample(
      404,
      'The profile has not been created yet (use PUT /customers/me)',
      {
        type: 'not-found',
        title: 'Not Found',
        detail: 'Customer profile not created yet',
        instance: '/v1/customers/me',
      },
    ),
  )
  async get(@CurrentUser() user: AuthenticatedUser): Promise<CustomerDto> {
    return customerView(
      await asHttp(() => this.getProfile.execute(user.userId)),
    );
  }

  @Put('me')
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: "Create or replace the caller's customer profile",
    description:
      'Role `CUSTOMER`. The customer is always the JWT `sub`; unknown fields (e.g. `customerId`) are rejected. ' +
      'Returns `201` when the profile is created and `200` when it is updated. ' +
      'On creation, and whenever the **email or phone** changes, `CustomerContactUpdated` is published to ' +
      '`profile.events` (key = customerId) with a higher `aggregateVersion`, through the outbox (F1-S1, ADR-015).',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Added by Kong; copied into the event',
  })
  @ApiCreatedResponse({ type: CustomerDto, description: 'Profile created' })
  @ApiOkResponse({ type: CustomerDto, description: 'Profile updated' })
  @ApiResponse(
    problemExample(400, 'Invalid name, email or phone, or an unknown field', {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      instance: '/v1/customers/me',
      errors: [{ field: 'email', message: 'email must be an email' }],
    }),
  )
  async put(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveCustomerProfileDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<CustomerDto> {
    const { customer, created } = await asHttp(() =>
      this.saveProfile.execute(
        user.userId,
        { name: body.name, email: body.email, phone: body.phone ?? null },
        correlationIdFrom(correlationId),
      ),
    );
    response.status(created ? 201 : 200);
    return customerView(customer);
  }
}
