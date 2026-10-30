/**
 * Use cases behind the REST API of spec 4.5 (preferences and devices).
 * The customer id always comes from the JWT (`sub`), never from the body.
 */
import { Injectable } from '@nestjs/common';
import { DEFAULT_PREFERENCES, type NotificationPreferences } from '../domain/notification.js';
import { DeviceRepository, PreferencesRepository, type Device } from './ports.js';

@Injectable()
export class ManagePreferences {
  constructor(private readonly preferences: PreferencesRepository) {}

  /** Stored preferences, or the defaults if never set (no row is created). */
  async get(customerId: string): Promise<NotificationPreferences> {
    return (await this.preferences.find(customerId)) ?? { ...DEFAULT_PREFERENCES };
  }

  /** Replaces the preferences (PUT semantics). */
  async update(customerId: string, preferences: NotificationPreferences): Promise<NotificationPreferences> {
    await this.preferences.save(customerId, preferences);
    return preferences;
  }
}

@Injectable()
export class RegisterDevice {
  constructor(private readonly devices: DeviceRepository) {}

  async execute(customerId: string, device: Device): Promise<void> {
    await this.devices.upsert(customerId, device);
  }
}
