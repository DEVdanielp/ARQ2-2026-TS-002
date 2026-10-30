/**
 * Domain vocabulary of the Notification Service (docs/spec.md section 3,
 * "Notifications" schemas).
 *
 * The domain layer (ADR-014, hexagonal architecture) holds the business
 * concepts and rules and depends on nothing else: no Nest, no TypeORM, no
 * Kafka. Use cases and adapters depend on it, never the other way around.
 */

/** What happened to the order (spec `NotificationType`). */
export const NotificationTypes = ['ORDER_CREATED', 'ON_THE_WAY', 'NEARBY', 'DELIVERED', 'CANCELLED'] as const;
export type NotificationType = (typeof NotificationTypes)[number];

/** How the customer is reached (spec `NotificationLogEntry.channel`). */
export const NotificationChannels = ['PUSH', 'EMAIL'] as const;
export type NotificationChannel = (typeof NotificationChannels)[number];

/**
 * Delivery state of one (order, type, channel) notification (spec
 * `NotificationLogEntry.status`), plus PENDING: an internal state for a row
 * that was claimed (inserted) but whose first send has not finished yet. It
 * lets the service insert first and send second, so the UNIQUE constraint
 * decides who sends. Not in the spec yet: to be agreed with the team.
 */
export const NotificationStatuses = ['PENDING', 'SENT', 'FAILED', 'RETRYING', 'DEAD_LETTERED'] as const;
export type NotificationStatus = (typeof NotificationStatuses)[number];

/** Platform of a push device (spec 4.5, `PUT /notifications/devices`). */
export const DevicePlatforms = ['ANDROID', 'IOS', 'WEB'] as const;
export type DevicePlatform = (typeof DevicePlatforms)[number];

/** Customer preferences (spec `NotificationPreferences`). */
export interface NotificationPreferences {
  push: boolean;
  email: boolean;
  /** The CREATED notification is optional and off by default. */
  notifyOnCreated: boolean;
}

/** Preferences of a customer who never set them (spec 4.5: "defaults if never set"). */
export const DEFAULT_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  push: true,
  email: true,
  notifyOnCreated: false,
});
