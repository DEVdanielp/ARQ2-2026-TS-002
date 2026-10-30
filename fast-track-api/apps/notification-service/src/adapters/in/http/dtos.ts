/**
 * Request and response shapes of the REST API (spec 4.5).
 *
 * - class-validator decorators: validated by the global ValidationPipe
 *   (`@libs/http` createValidationPipe); invalid or unknown fields -> 400.
 * - @ApiProperty decorators: describe the same shapes in the OpenAPI
 *   (Swagger) document, so the docs cannot drift from what is validated.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  DevicePlatforms,
  NotificationChannels,
  NotificationStatuses,
  NotificationTypes,
  type DevicePlatform,
  type NotificationChannel,
  type NotificationStatus,
  type NotificationType,
} from '../../../domain/notification.js';

/** Spec `NotificationPreferences` (request of PUT /notifications/preferences). */
export class UpdatePreferencesDto {
  @ApiProperty({ example: true, description: 'Receive push notifications' })
  @IsBoolean()
  push: boolean;

  @ApiProperty({ example: false, description: 'Receive emails. false = no email for ANY notification type (F5-S5)' })
  @IsBoolean()
  email: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description: 'Also notify when the order is created (optional notification). PUT replaces: omitted = false',
  })
  @IsOptional()
  @IsBoolean()
  notifyOnCreated?: boolean;
}

/** Spec `NotificationPreferences` (response). */
export class NotificationPreferencesDto {
  @ApiProperty({ example: true })
  push: boolean;

  @ApiProperty({ example: true })
  email: boolean;

  @ApiProperty({ example: false })
  notifyOnCreated: boolean;
}

export class RegisterDeviceDto {
  @ApiProperty({ example: 'fcm:dGhpcyBpcyBhIHRva2Vu', maxLength: 4096, description: 'Firebase Cloud Messaging token' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  deviceToken: string;

  @ApiProperty({ enum: DevicePlatforms, example: 'ANDROID' })
  @IsIn(DevicePlatforms)
  platform: DevicePlatform;
}

/** Spec `NotificationLogEntry` (response of GET /notifications/orders/{orderId}). */
export class NotificationLogEntryDto {
  @ApiProperty({ format: 'uuid', example: '6f1c2b7e-0000-4000-8000-000000000001' })
  orderId: string;

  @ApiProperty({ enum: NotificationTypes, example: 'ON_THE_WAY' })
  type: NotificationType;

  @ApiProperty({ enum: NotificationChannels, example: 'PUSH' })
  channel: NotificationChannel;

  @ApiProperty({
    enum: NotificationStatuses,
    example: 'SENT',
    description:
      'PENDING = being sent · SENT · FAILED · RETRYING = scheduled retry (1, 5, 15 min) · DEAD_LETTERED = retries exhausted',
  })
  status: NotificationStatus;

  @ApiProperty({ example: 1, description: 'Send attempts: first send + retries' })
  attempts: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-10-18T15:05:02Z' })
  sentAt: string | null;
}
