/**
 * Kafka inbound adapter: subscribes to the four topics that feed the view and
 * routes every event to ProjectTrackingEvent.
 *
 * | Topic                | Events                                                      |
 * | -------------------- | ----------------------------------------------------------- |
 * | orders.events        | OrderCreated, OrderOnTheWay, OrderDelivered, OrderCancelled |
 * | assignment.events    | DriverAssigned, DriverUnassigned, AssignmentFailed          |
 * | tracking.locations   | LocationUpdated                                             |
 * | tracking.proximity   | DriverNearDestination                                       |
 *
 * ONE subscription per topic (group `tracking-query-service`): two consumers
 * of the same group on one topic would split its partitions.
 *
 * Error policy (from @libs/kafka): a handler that throws is retried in process
 * (200 ms, 1 s, 5 s) and then sent to `<topic>.dlq`. Throws happen for an
 * invalid payload or when Redis/PostgreSQL are down; stale or duplicate events
 * are simply no-ops (ADR-009).
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';
import { ProjectTrackingEvent } from '../../../application/project-tracking-event.js';
import { toViewChange } from './event-payloads.js';

export const CONSUMED_TOPICS = [
  Topics.ORDERS_EVENTS,
  Topics.ASSIGNMENT_EVENTS,
  Topics.TRACKING_LOCATIONS,
  Topics.TRACKING_PROXIMITY,
] as const;

@Injectable()
export class TrackingEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrackingEventsConsumer.name);

  constructor(
    private readonly kafka: KafkaConsumerService,
    private readonly project: ProjectTrackingEvent,
  ) {}

  /** Runs after every module is initialised (Redis and the archive ready). */
  async onApplicationBootstrap(): Promise<void> {
    // groupId defaults to the clientId: 'tracking-query-service'.
    for (const topic of CONSUMED_TOPICS) {
      await this.kafka.subscribe({ topic, handler: (envelope) => this.onEvent(envelope) });
    }
  }

  async onEvent(envelope: EventEnvelope): Promise<void> {
    const change = toViewChange(envelope);
    if (!change) {
      this.logger.debug?.({ msg: 'Event ignored', eventType: envelope.eventType, eventId: envelope.eventId });
      return;
    }
    const changed = await this.project.execute(change);
    this.logger.debug?.({ msg: changed ? 'View updated' : 'Stale or duplicate event', eventType: envelope.eventType, orderId: change.orderId });
  }
}
