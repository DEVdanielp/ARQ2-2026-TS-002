/**
 * Profiles & Assignment's part of the order fulfillment saga (spec 1, ADR-016):
 *
 *   OrderCreated   -> look for a driver now; if none, retry every 30 s (F1-S2, F1-S3)
 *   (10 min later) -> AssignmentFailed, the order stays CREATED      (F1-S3b)
 *   OrderOnTheWay  -> the order can no longer be released by its driver going OFFLINE
 *   OrderDelivered / OrderCancelled -> release the driver's slot      (F1-S5, F4-S9)
 *
 * Driver availability changes (F1-S6) live in driver-profile.use-cases.ts and
 * reuse `Assigner` from this file.
 *
 * Every handler runs in ONE assignment session: it marks the event processed,
 * changes the tables and writes its events to the outbox atomically, so a
 * redelivered event changes nothing (ADR-009) and no event is lost (ADR-005).
 */
import { Injectable, Logger } from '@nestjs/common';
import { strictlyAfter } from '../domain/assignment-window.js';
import { availabilityFor, chooseDriver } from '../domain/driver-rules.js';
import type {
  AssignmentRequest,
  Destination,
  OrderStatus,
  ReleaseReason,
} from '../domain/profiles.js';
import { assignmentFailed, driverAssigned } from './events.js';
import { UnknownOrderError } from './errors.js';
import {
  AssignmentSettings,
  Clock,
  ProfilesStore,
  type AssignmentSession,
} from './ports.js';

export type AttemptOutcome =
  'ASSIGNED' | 'NO_DRIVER' | 'FAILED' | 'NOT_PENDING';

/**
 * One assignment attempt for one order, inside a session (the shared step of
 * OrderCreated, the retry scheduler and a driver going OFFLINE).
 */
@Injectable()
export class Assigner {
  private readonly logger = new Logger(Assigner.name);

  constructor(private readonly settings: AssignmentSettings) {}

  /**
   * - Window over (10 min): the request becomes FAILED and `AssignmentFailed` is published (F1-S3b).
   * - A driver is eligible: the order is assigned and `DriverAssigned` is published (F1-S2).
   * - Nobody is eligible: the next attempt is scheduled 30 s later (F1-S3).
   *
   * @param correlationId - defaults to the correlation of the order's OrderCreated.
   */
  async attempt(
    session: AssignmentSession,
    request: AssignmentRequest,
    now: Date,
    correlationId: string = request.correlationId,
  ): Promise<AttemptOutcome> {
    if (request.orderStatus !== 'CREATED' || request.state !== 'PENDING')
      return 'NOT_PENDING';

    const { window } = this.settings;
    if (window.isExpired(request, now)) {
      request.state = 'FAILED';
      request.nextAttemptAt = null;
      await session.saveRequest(request);
      await session.publish(assignmentFailed(request, now, correlationId));
      this.logger.warn({
        msg: 'No driver assigned within the window: AssignmentFailed',
        orderId: request.orderId,
        attempts: request.attempts,
        correlationId,
      });
      return 'FAILED';
    }

    request.attempts += 1;
    const driver = chooseDriver(await session.findAssignableDrivers());
    if (!driver) {
      request.nextAttemptAt = window.nextAttemptAfter(now);
      await session.saveRequest(request);
      this.logger.log({
        msg: 'No driver available; will retry',
        orderId: request.orderId,
        attempt: request.attempts,
        nextAttemptAt: request.nextAttemptAt,
        correlationId,
      });
      return 'NO_DRIVER';
    }

    await session.openAssignment(request.orderId, driver.driverId, now);
    driver.activeOrderIds = [...driver.activeOrderIds, request.orderId];
    driver.availability = availabilityFor(
      driver.availability,
      driver.activeOrderIds.length,
    );
    driver.lastAssignedAt = now;
    await session.saveDriver(driver);

    request.state = 'ASSIGNED';
    request.driverId = driver.driverId;
    request.nextAttemptAt = null;
    await session.saveRequest(request);

    await session.publish(driverAssigned(request, driver, now, correlationId));
    this.logger.log({
      msg: 'Driver assigned',
      orderId: request.orderId,
      driverId: driver.driverId,
      correlationId,
    });
    return 'ASSIGNED';
  }

  /**
   * Releases the order's active assignment, if any: frees the slot and
   * recomputes the driver's availability (F1-S5). Publishes nothing: the
   * caller decides whether the release is an event (only `DRIVER_OFFLINE` is).
   *
   * @returns the driver that had the order, or null.
   */
  async release(
    session: AssignmentSession,
    orderId: string,
    now: Date,
    reason: ReleaseReason,
  ): Promise<string | null> {
    const active = await session.findActiveAssignment(orderId);
    if (!active) return null;

    await session.releaseAssignment(orderId, now, reason);
    const driver = await session.findDriver(active.driverId);
    if (driver) {
      driver.activeOrderIds = driver.activeOrderIds.filter(
        (id) => id !== orderId,
      );
      driver.availability = availabilityFor(
        driver.availability,
        driver.activeOrderIds.length,
      );
      await session.saveDriver(driver);
    }
    return active.driverId;
  }
}

// ---------------------------------------------------------------- OrderCreated

export interface OrderCreatedInput {
  eventId: string;
  correlationId: string;
  orderId: string;
  customerId: string;
  destination: Destination;
  /** aggregateVersion of the event; 1 for OrderCreated (spec 5.4). */
  version: number;
}

@Injectable()
export class StartAssignment {
  constructor(
    private readonly store: ProfilesStore,
    private readonly assigner: Assigner,
    private readonly clock: Clock,
  ) {}

  /** Saga step 2: register the order and try to assign it at once (F1-S2, F1-S3). */
  async execute(
    input: OrderCreatedInput,
  ): Promise<AttemptOutcome | 'DUPLICATE'> {
    return this.store.inAssignmentSession(async (session) => {
      if (!(await session.markProcessed(input.eventId, 'OrderCreated')))
        return 'DUPLICATE';
      if (await session.findRequest(input.orderId)) return 'DUPLICATE';

      const now = this.clock.now();
      const request: AssignmentRequest = {
        orderId: input.orderId,
        customerId: input.customerId,
        destination: input.destination,
        orderStatus: 'CREATED',
        orderVersion: input.version,
        state: 'PENDING',
        driverId: null,
        attempts: 0,
        windowStartedAt: now,
        nextAttemptAt: now,
        correlationId: input.correlationId,
      };
      await session.saveRequest(request);
      return this.assigner.attempt(session, request, now);
    });
  }
}

// ---------------------------------------------------------------- scheduler tick

@Injectable()
export class RetryDueAssignments {
  private readonly logger = new Logger(RetryDueAssignments.name);

  constructor(
    private readonly store: ProfilesStore,
    private readonly assigner: Assigner,
    private readonly settings: AssignmentSettings,
    private readonly clock: Clock,
  ) {}

  /**
   * Retries every order whose next attempt is due (F1-S3), or fails it when
   * its window is over (F1-S3b). Called by the scheduler every second; the
   * due times live in the database, so retries survive a restart.
   */
  async execute(): Promise<Record<AttemptOutcome, number>> {
    const counts: Record<AttemptOutcome, number> = {
      ASSIGNED: 0,
      NO_DRIVER: 0,
      FAILED: 0,
      NOT_PENDING: 0,
    };
    const due = await this.store.inAssignmentSession(async (session) =>
      session.findDueRequests(this.clock.now(), this.settings.dueBatchSize),
    );

    // One transaction per order: an order whose attempt fails (e.g. invalid
    // data) is logged and retried on the next tick without rolling back or
    // blocking the others.
    for (const { orderId } of due) {
      try {
        const outcome = await this.store.inAssignmentSession(
          async (session) => {
            // Re-read under the lock: an event may have changed it since.
            const request = await session.findRequest(orderId);
            const now = this.clock.now();
            if (
              !request ||
              !request.nextAttemptAt ||
              request.nextAttemptAt > now
            ) {
              return 'NOT_PENDING' as const;
            }
            return this.assigner.attempt(session, request, now);
          },
        );
        counts[outcome] += 1;
      } catch (error) {
        this.logger.error({
          msg: 'Assignment attempt failed; retried on the next tick',
          orderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return counts;
  }
}

// ---------------------------------------------------------------- OrderOnTheWay / OrderDelivered / OrderCancelled

export interface OrderStatusInput {
  eventId: string;
  eventType: string;
  orderId: string;
  status: Exclude<OrderStatus, 'CREATED'>;
  /** aggregateVersion of the event (required: spec 5.4). */
  version: number;
  /** Driver carried by the event, if any (Orders is the source of truth). */
  driverId: string | null;
  /** Correlation id of the event; defaults to the one of the order's OrderCreated. */
  correlationId?: string;
}

export type StatusOutcome = 'APPLIED' | 'DUPLICATE' | 'STALE';

@Injectable()
export class TrackOrderStatus {
  private readonly logger = new Logger(TrackOrderStatus.name);

  constructor(
    private readonly store: ProfilesStore,
    private readonly assigner: Assigner,
    private readonly clock: Clock,
  ) {}

  /**
   * - ON_THE_WAY: the order stops being releasable (a driver with it cannot go
   *   OFFLINE, spec 4.1 409). If Orders reports a different driver than ours,
   *   Orders wins: our assignment follows it (ADR-019).
   * - DELIVERED / CANCELLED: the slot is released and retries stop (F1-S5,
   *   saga compensation of `OrderCancelled`).
   *
   * Status by `aggregateVersion`: a late or repeated event never moves the
   * order backward (spec 1, Consistency rules).
   */
  async execute(input: OrderStatusInput): Promise<StatusOutcome> {
    return this.store.inAssignmentSession(async (session) => {
      if (!(await session.markProcessed(input.eventId, input.eventType)))
        return 'DUPLICATE';
      const request = await session.findRequest(input.orderId);
      if (!request) throw new UnknownOrderError(input.orderId);
      if (input.version <= request.orderVersion) return 'STALE';

      const now = this.clock.now();
      request.orderVersion = input.version;
      request.orderStatus = input.status;
      request.nextAttemptAt = null;

      if (input.status === 'ON_THE_WAY') {
        await this.followOrdersDriver(
          session,
          request,
          input.driverId,
          now,
          input.correlationId ?? request.correlationId,
        );
      } else {
        await this.assigner.release(
          session,
          request.orderId,
          now,
          input.status,
        );
        request.driverId = null;
      }
      await session.saveRequest(request);
      return 'APPLIED';
    });
  }

  /**
   * Aligns our assignment with the driver Orders reports for the picked-up
   * order.
   *
   * Rare race: the pickup of driver A was accepted by Orders just before A
   * went OFFLINE and we reassigned the order to B. Orders is the source of
   * truth, so the assignment moves back to A and `DriverAssigned(A)` is
   * published again, so the GPS Tracking Worker (route of A, with the
   * destination) and Tracking Query (driver shown) follow too. A
   * `DriverUnassigned(B)` would be useless: consumers ignore it once the order
   * is not CREATED (spec 5.4).
   */
  private async followOrdersDriver(
    session: AssignmentSession,
    request: AssignmentRequest,
    driverId: string | null,
    now: Date,
    correlationId: string,
  ) {
    const active = await session.findActiveAssignment(request.orderId);
    if (!driverId || active?.driverId === driverId) {
      if (active) request.state = 'ASSIGNED';
      return;
    }

    this.logger.warn({
      msg: 'OrderOnTheWay names another driver; following Orders',
      orderId: request.orderId,
      ours: active?.driverId ?? null,
      orders: driverId,
      correlationId,
    });
    const at = strictlyAfter(active?.assignedAt, now);
    if (active)
      await this.assigner.release(session, request.orderId, at, 'REASSIGNED');
    request.driverId = null;

    // Load the driver BEFORE opening the assignment: activeOrderIds is derived from it.
    const driver = await session.findDriver(driverId);
    if (!driver) {
      this.logger.error({
        msg: 'OrderOnTheWay names a driver without a profile; no assignment recorded',
        orderId: request.orderId,
        driverId,
      });
      return;
    }
    await session.openAssignment(request.orderId, driverId, at);
    driver.activeOrderIds = [...driver.activeOrderIds, request.orderId];
    driver.availability = availabilityFor(
      driver.availability,
      driver.activeOrderIds.length,
    );
    await session.saveDriver(driver);
    request.state = 'ASSIGNED';
    request.driverId = driverId;
    await session.publish(driverAssigned(request, driver, at, correlationId));
  }
}
