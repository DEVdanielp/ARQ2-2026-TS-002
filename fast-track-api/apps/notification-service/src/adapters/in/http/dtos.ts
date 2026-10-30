/**
 * Request bodies of the REST API (spec 4.5), validated by the global
 * ValidationPipe (`@libs/http` createValidationPipe): invalid or unknown
 * fields produce a 400 problem+json listing each field.
 */
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DevicePlatforms, type DevicePlatform } from '../../../domain/notification.js';

/** Spec `NotificationPreferences`: `push` and `email` required. */
export class UpdatePreferencesDto {
  @IsBoolean()
  push: boolean;

  @IsBoolean()
  email: boolean;

  /** Optional; PUT replaces the preferences, so omitting it means false. */
  @IsOptional()
  @IsBoolean()
  notifyOnCreated?: boolean;
}

export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  deviceToken: string;

  @IsIn(DevicePlatforms)
  platform: DevicePlatform;
}
