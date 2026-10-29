/**
 * Kafka topic names used by FastTrack (docs/spec.md section 5.1).
 *
 * Why it exists
 * -------------
 * A topic name is just a string, and Kafka will not warn us about a typo:
 * auto topic creation is disabled in our broker, so a producer that writes to
 * "gps.batch" (missing "es") would simply fail at runtime, and a consumer
 * subscribed to a wrong name would wait forever. Keeping the names in one
 * place means nobody types them by hand, and the compiler catches mistakes.
 *
 * The topics themselves are created by deploy/kafka/create-topics.sh; if you
 * add a topic here, add it there too (and to the spec).
 */

/**
 * Every topic from the spec, with its key and partition count as documentation.
 * The key is what decides the partition, and therefore the ordering (ADR-001).
 */
export const Topics = {
  /** Key `driverId`, 24 partitions. Producer: GPS Ingestion API. Event: GpsBatchReceived. */
  GPS_BATCHES: 'gps.batches',
  /** Key `orderId`, 12 partitions. Producer: Orders. Events: PickupConfirmed, DeliveryConfirmed, CancellationRequested. */
  ORDERS_INTENTS: 'orders.intents',
  /** Key `orderId`, 12 partitions. Producer: Orders. Events: OrderCreated, OrderOnTheWay, OrderDelivered, OrderCancelled. */
  ORDERS_EVENTS: 'orders.events',
  /** Key `orderId`, 12 partitions. Producer: Profiles & Assignment. Events: DriverAssigned, DriverUnassigned, AssignmentFailed. */
  ASSIGNMENT_EVENTS: 'assignment.events',
  /** Key `customerId`, 6 partitions. Producer: Profiles & Assignment. Event: CustomerContactUpdated. */
  PROFILE_EVENTS: 'profile.events',
  /** Key `orderId`, 12 partitions. Producer: GPS Tracking Worker. Event: LocationUpdated. */
  TRACKING_LOCATIONS: 'tracking.locations',
  /** Key `orderId`, 12 partitions. Producer: GPS Tracking Worker. Event: DriverNearDestination. */
  TRACKING_PROXIMITY: 'tracking.proximity',
  /** Key `orderId`, 6 partitions. Producer: Notification Service. Event: NotificationRetry. */
  NOTIFICATIONS_RETRY: 'notifications.retry',
} as const;

/** Union of every valid topic name, e.g. `'gps.batches' | 'orders.events' | ...`. */
export type Topic = (typeof Topics)[keyof typeof Topics];

/** Name of a dead-letter topic, e.g. `'gps.batches.dlq'`. */
export type DlqTopic = `${Topic}.dlq`;

/** Suffix appended to a topic name to get its dead-letter queue. */
export const DLQ_SUFFIX = '.dlq';

/**
 * Returns the dead-letter queue (DLQ) topic of a source topic: `<topic>.dlq`.
 *
 * A DLQ is where a consumer parks a message it could not process after all its
 * retries, so the partition can keep moving and a human can inspect the message
 * later (ADR-012, spec 5.1 row `<topic>.dlq`).
 *
 * @example dlqTopic(Topics.GPS_BATCHES) // 'gps.batches.dlq'
 */
export function dlqTopic<T extends Topic>(topic: T): `${T}.dlq`;
export function dlqTopic(topic: string): string;
export function dlqTopic(topic: string): string {
  return `${topic}${DLQ_SUFFIX}`;
}
