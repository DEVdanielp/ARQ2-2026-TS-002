/**
 * Which channels a notification goes through: a pure business rule.
 *
 * A channel is used only if the customer allows it AND we can reach them on
 * it. Disabling email means no email for ANY notification type (F5-S5).
 */
import type { NotificationChannel, NotificationPreferences } from './notification.js';

/** What we know about how to reach the customer. */
export interface Reachability {
  /** We have their email (replicated from CustomerContactUpdated). */
  hasEmail: boolean;
  /** They registered at least one push device. */
  hasDevice: boolean;
}

export function selectChannels(
  preferences: NotificationPreferences,
  reachability: Reachability,
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (preferences.push && reachability.hasDevice) channels.push('PUSH');
  if (preferences.email && reachability.hasEmail) channels.push('EMAIL');
  return channels;
}
