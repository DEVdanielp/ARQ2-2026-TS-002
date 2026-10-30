/**
 * Kafka inbound adapter: subscribes to the topics this worker consumes and
 * routes each event to its use case.
 *
 * | Topic             | Event                                         | Use case           |
 * | ----------------- | --------------------------------------------- | ------------------ |
 * | gps.batches       | GpsBatchReceived                              | ProcessGpsBatch    |
 * | assignment.events | DriverAssigned                                | AssignRouteOrder   |
 * | assignment.events | DriverUnassigned                              | UnassignRouteOrder |
 * | orders.events     | OrderOnTheWay, OrderDelivered, OrderCancelled | TrackOrderStatus   |
 *
 * ONE subscription per topic (group `gps-tracking-worker`): two consumers of
 * the same group on the same topic would split its partitions. Events we do
 * not need (OrderCreated, AssignmentFailed) are ignored without error.
 *
 * Ordering: `gps.batches` is keyed by driverId, so @libs/kafka hands this
 * adapter the batches of one driver one at a time, in publication order
 * (ADR-001). Different drivers run in parallel (one per partition).
 *
 * Error policy (from @libs/kafka): a handler that throws is retried in process
 * (200 ms, 1 s, 5 s) and then sent to `<topic>.dlq`. The use cases throw only
 * when retrying can help (database down) or the payload is invalid.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Topics, type EventEnvelope } from '@libs/events';
import { KafkaConsumerService } from '@libs/kafka';
import type { OrderStatus } from '../../../domain/tracking.js';
import { ProcessGpsBatch } from '../../../application/process-gps-batch.js';
import { AssignRouteOrder, TrackOrderStatus, UnassignRouteOrder } from '../../../application/route-orders.use-cases.js';
import {
  parseDriverAssigned,
  parseDriverUnassigned,
  parseGpsBatchReceived,
  parseOrderStatusEvent,
} from './event-payloads.js';

/** Status events that start or stop the monitoring of an order (saga steps 4–7). */
const ORDER_STATUS_BY_EVENT: Record<string, OrderStatus> = {
  OrderOnTheWay: 'ON_THE_WAY',
  OrderDelivered: 'DELIVERED',
  OrderCancelled: 'CANCELLED',
};

@Injectable()
export class GpsTrackingConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(GpsTrackingConsumer.name);

  constructor(
    private readonly kafka: KafkaConsumerService,
    private readonly processGpsBatch: ProcessGpsBatch,
    private readonly trackOrderStatus: TrackOrderStatus,
    private readonly assignRouteOrder: AssignRouteOrder,
    private readonly unassignRouteOrder: UnassignRouteOrder,
  ) {}

  /** Runs after every module is initialised (producer, outbox and partitions ready). */
  async onApplicationBootstrap(): Promise<void> {
    // groupId defaults to the clientId: 'gps-tracking-worker'.
    await this.kafka.subscribe({ topic: Topics.GPS_BATCHES, handler: (e) => this.onGpsBatch(e) });
    await this.kafka.subscribe({ topic: Topics.ASSIGNMENT_EVENTS, handler: (e) => this.onAssignmentEvent(e) });
    await this.kafka.subscribe({ topic: Topics.ORDERS_EVENTS, handler: (e) => this.onOrderEvent(e) });
  }

  /** gps.batches */
  async onGpsBatch(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== 'GpsBatchReceived') return this.ignore(envelope);
    const payload = parseGpsBatchReceived(envelope.payload);
    const result = await this.processGpsBatch.execute({ payload, correlationId: envelope.correlationId });
    this.logger.log({
      msg: 'GPS batch processed',
      driverId: payload.driverId,
      batchId: payload.batchId,
      points: payload.points.length,
      ...result,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
    });
  }

  /** assignment.events */
  async onAssignmentEvent(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType === 'DriverAssigned') {
      await this.assignRouteOrder.execute(envelope.eventId, parseDriverAssigned(envelope.payload), envelope.correlationId);
      return;
    }
    if (envelope.eventType === 'DriverUnassigned') {
      await this.unassignRouteOrder.execute(envelope.eventId, parseDriverUnassigned(envelope.payload), envelope.correlationId);
      return;
    }
    this.ignore(envelope);
  }

  /** orders.events */
  async onOrderEvent(envelope: EventEnvelope): Promise<void> {
    const status = ORDER_STATUS_BY_EVENT[envelope.eventType];
    if (!status) return this.ignore(envelope);
    const { orderId, version, driverId } = parseOrderStatusEvent(envelope.eventType, envelope.payload, envelope.aggregateVersion);
    await this.trackOrderStatus.execute({ orderId, status, version, driverId }, envelope.correlationId);
  }

  private ignore(envelope: EventEnvelope): void {
    this.logger.debug?.({ msg: 'Event ignored', eventType: envelope.eventType, eventId: envelope.eventId });
  }
}
