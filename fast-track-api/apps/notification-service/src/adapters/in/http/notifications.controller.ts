/**
 * REST API of the Notification Service (spec 4.5), behind Kong at
 * `/v1/notifications/...` (the `v1` prefix is set in main.ts).
 *
 * A controller is an INBOUND ADAPTER (ADR-014): it translates HTTP into
 * use-case calls and use-case results/errors back into HTTP. It holds no
 * business rules. The @Api* decorators produce the Swagger documentation.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser, RequireRoles, Roles, type AuthenticatedUser } from '@libs/auth';
import { ApiProblemResponses } from '@libs/http';
import type { NotificationPreferences } from '../../../domain/notification.js';
import { OrderNotVisibleError } from '../../../application/errors.js';
import { GetNotificationLog, type NotificationLogView } from '../../../application/get-notification-log.js';
import { ManagePreferences, RegisterDevice } from '../../../application/preferences.use-cases.js';
import { NotificationLogEntryDto, NotificationPreferencesDto, RegisterDeviceDto, UpdatePreferencesDto } from './dtos.js';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiProblemResponses(401, 403, 500)
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly preferences: ManagePreferences,
    private readonly registerDevice: RegisterDevice,
    private readonly notificationLog: GetNotificationLog,
  ) {}

  @Get('preferences')
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: "Get the caller's notification preferences",
    description: 'Role `CUSTOMER`. Returns the defaults (push and email on, CREATED off) if never set.',
  })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  getPreferences(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferences> {
    return this.preferences.get(user.userId);
  }

  @Put('preferences')
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: "Replace the caller's notification preferences",
    description:
      'Role `CUSTOMER`. The customer is always the JWT `sub`; unknown fields (e.g. `customerId`) are rejected. ' +
      'With `email: false` no email is sent for any notification type (F5-S5).',
  })
  @ApiOkResponse({ type: NotificationPreferencesDto, description: 'The stored preferences' })
  @ApiProblemResponses(400)
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdatePreferencesDto,
  ): Promise<NotificationPreferences> {
    return this.preferences.update(user.userId, {
      push: body.push,
      email: body.email,
      notifyOnCreated: body.notifyOnCreated ?? false,
    });
  }

  @Put('devices')
  @HttpCode(204)
  @RequireRoles(Roles.CUSTOMER)
  @ApiOperation({
    summary: 'Register the device token used for push notifications',
    description:
      'Role `CUSTOMER`. Idempotent. A token already registered by another account moves to the caller ' +
      '(same phone, new login).',
  })
  @ApiNoContentResponse({ description: 'Device registered' })
  @ApiProblemResponses(400)
  async putDevice(@CurrentUser() user: AuthenticatedUser, @Body() body: RegisterDeviceDto): Promise<void> {
    await this.registerDevice.execute(user.userId, { deviceToken: body.deviceToken, platform: body.platform });
  }

  @Get('orders/:orderId')
  @RequireRoles(Roles.CUSTOMER, Roles.OPERATIONS)
  @ApiOperation({
    summary: 'Delivery log of an order (support and auditing)',
    description:
      'Role `CUSTOMER` (only their own orders) or `OPERATIONS` (any order). One entry per notification type and ' +
      "channel. Another customer's order returns 404, so its existence is not revealed.",
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: [NotificationLogEntryDto] })
  @ApiProblemResponses(400, 404)
  async getOrderLog(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<NotificationLogView[]> {
    try {
      return await this.notificationLog.execute(orderId, user);
    } catch (error) {
      if (error instanceof OrderNotVisibleError) throw new NotFoundException(error.message);
      throw error;
    }
  }
}
