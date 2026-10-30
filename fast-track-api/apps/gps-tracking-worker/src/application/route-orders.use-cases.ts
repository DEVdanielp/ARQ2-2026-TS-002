/**
 * Local copy of what the worker needs to know about orders (ADR-015):
 * which driver carries each order, where it goes, and whether it is still
 * being delivered. The worker never decides the status; it only follows the
 * events of the owners (Orders, Profiles & Assignment).
 *
 * The events of one order travel on different topics, so they can arrive in
 * any order (spec 1, consistency rules; ADR-016). Every rule below is
 * order-tolerant and idempotent:
 *
 * - Status by `aggregateVersion`: an older or repeated status is ignored.
 * - DriverAssigned for a terminal order is ignored.
 * - DriverUnassigned only removes the order if it is still that driver's and
 *   still CREATED.
 * - Assignment events are deduplicated by eventId.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  RouteOrderRepository,
  type AssignOutcome,
  type DriverAssignment,
  type DriverUnassignment,
  type OrderStatusChange,
  type UnassignOutcome,
} from './ports.js';

/** OrderOnTheWay starts monitoring; OrderDelivered / OrderCancelled stop it (saga steps 4–7). */
@Injectable()
export class TrackOrderStatus {
  private readonly logger = new Logger(TrackOrderStatus.name);

  constructor(private readonly orders: RouteOrderRepository) {}

  async execute(change: OrderStatusChange, correlationId: string): Promise<boolean> {
    const applied = await this.orders.applyStatus(change);
    this.logger.log({
      msg: applied ? 'Order status tracked' : 'Order status ignored (not newer)',
      orderId: change.orderId,
      status: change.status,
      version: change.version,
      correlationId,
    });
    return applied;
  }
}

/** DriverAssigned: the order joins the driver's route. */
@Injectable()
export class AssignRouteOrder {
  private readonly logger = new Logger(AssignRouteOrder.name);

  constructor(private readonly orders: RouteOrderRepository) {}

  async execute(eventId: string, assignment: DriverAssignment, correlationId: string): Promise<AssignOutcome> {
    const outcome = await this.orders.assign(eventId, assignment);
    this.logger.log({ msg: 'DriverAssigned handled', outcome, orderId: assignment.orderId, driverId: assignment.driverId, correlationId });
    return outcome;
  }
}

/** DriverUnassigned (saga compensation): the order leaves the driver's route. */
@Injectable()
export class UnassignRouteOrder {
  private readonly logger = new Logger(UnassignRouteOrder.name);

  constructor(private readonly orders: RouteOrderRepository) {}

  async execute(eventId: string, unassignment: DriverUnassignment, correlationId: string): Promise<UnassignOutcome> {
    const outcome = await this.orders.unassign(eventId, unassignment);
    this.logger.log({
      msg: 'DriverUnassigned handled',
      outcome,
      orderId: unassignment.orderId,
      driverId: unassignment.driverId,
      correlationId,
    });
    return outcome;
  }
}
