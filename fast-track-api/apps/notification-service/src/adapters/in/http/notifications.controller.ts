/**
 * REST API of the Notification Service (spec 4.5), behind Kong at
 * `/v1/notifications/...` (the `v1` prefix is set in main.ts).
 *
 * A controller is an INBOUND ADAPTER (ADR-014): it translates HTTP into
 * use-case calls and use-case results/errors back into HTTP. It holds no
 * business rules.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, RequireRoles, Roles, type AuthenticatedUser } from '@libs/auth';
import type { NotificationPreferences } from '../../../domain/notification.js';
import { OrderNotVisibleError } from '../../../application/errors.js';
import { GetNotificationLog, type NotificationLogView } from '../../../application/get-notification-log.js';
import { ManagePreferences, RegisterDevice } from '../../../application/preferences.use-cases.js';
import { RegisterDeviceDto, UpdatePreferencesDto } from './dtos.js';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly preferences: ManagePreferences,
    private readonly registerDevice: RegisterDevice,
    private readonly notificationLog: GetNotificationLog,
  ) {}

  /** `GET /notifications/preferences`: the caller's preferences (defaults if never set). */
  @Get('preferences')
  @RequireRoles(Roles.CUSTOMER)
  getPreferences(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferences> {
    return this.preferences.get(user.userId);
  }

  /** `PUT /notifications/preferences`: replaces the caller's preferences. */
  @Put('preferences')
  @RequireRoles(Roles.CUSTOMER)
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

  /** `PUT /notifications/devices`: registers the caller's push device. */
  @Put('devices')
  @HttpCode(204)
  @RequireRoles(Roles.CUSTOMER)
  async putDevice(@CurrentUser() user: AuthenticatedUser, @Body() body: RegisterDeviceDto): Promise<void> {
    await this.registerDevice.execute(user.userId, { deviceToken: body.deviceToken, platform: body.platform });
  }

  /** `GET /notifications/orders/{orderId}`: delivery log (owner or operations). */
  @Get('orders/:orderId')
  @RequireRoles(Roles.CUSTOMER, Roles.OPERATIONS)
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
