/**
 * Driver use cases (spec 4.1): profile, availability, capacity, and the
 * assignment lookup for operations.
 *
 * Availability and capacity change who can receive orders, so they run in an
 * assignment session (serialized with the assignment itself, ADR-019).
 */
import { Injectable, Logger } from '@nestjs/common';
import { strictlyAfter } from '../domain/assignment-window.js';
import { availabilityFor, checkCapacity } from '../domain/driver-rules.js';
import type {
  Assignment,
  Driver,
  SelectableAvailability,
} from '../domain/profiles.js';
import { Assigner } from './assignment.use-cases.js';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.js';
import { driverUnassigned } from './events.js';
import { AssignmentSettings, Clock, ProfilesStore } from './ports.js';

export interface DriverProfileInput {
  name: string;
  phone: string;
  vehiclePlate: string;
}

const driverNotFound = () =>
  new NotFoundError('driver', 'Driver profile not created yet');

@Injectable()
export class SaveDriverProfile {
  constructor(
    private readonly store: ProfilesStore,
    private readonly settings: AssignmentSettings,
    private readonly clock: Clock,
  ) {}

  /**
   * `PUT /drivers/me`: creates the profile OFFLINE with the default capacity
   * (spec 4.1 example: 3), or updates name, phone and plate. Availability and
   * capacity are not touched here (they have their own endpoints).
   */
  async execute(
    driverId: string,
    input: DriverProfileInput,
  ): Promise<{ driver: Driver; created: boolean }> {
    return this.store.inAssignmentSession(async (session) => {
      const current = await session.findDriver(driverId);
      const driver: Driver = current
        ? { ...current, ...input }
        : {
            driverId,
            ...input,
            availability: 'OFFLINE',
            capacity: this.settings.defaultDriverCapacity,
            activeOrderIds: [],
            lastAssignedAt: null,
            createdAt: this.clock.now(),
          };
      await session.saveDriver(driver);
      return { driver, created: current === null };
    });
  }
}

@Injectable()
export class ChangeDriverAvailability {
  private readonly logger = new Logger(ChangeDriverAvailability.name);

  constructor(
    private readonly store: ProfilesStore,
    private readonly assigner: Assigner,
    private readonly clock: Clock,
  ) {}

  /**
   * `PATCH /drivers/me/availability` (spec 4.1, F1-S6).
   *
   * - AVAILABLE: the driver can receive orders; shown as EN_ROUTE while they
   *   have active orders. Orders waiting for a driver get them at their next
   *   attempt (at most 30 s later).
   * - OFFLINE: refused with 409 while an order is ON_THE_WAY. Every order
   *   still CREATED is released with `DriverUnassigned` and its assignment
   *   restarts with a new 10-minute window (saga compensation, ADR-016).
   *
   * @throws {NotFoundError} no driver profile (404).
   * @throws {ConflictError} OFFLINE with orders ON_THE_WAY (409).
   */
  async execute(
    driverId: string,
    availability: SelectableAvailability,
    correlationId: string,
  ): Promise<Driver> {
    return this.store.inAssignmentSession(async (session) => {
      const driver = await session.findDriver(driverId);
      if (!driver) throw driverNotFound();

      if (availability === 'AVAILABLE') {
        driver.availability = availabilityFor(
          'AVAILABLE',
          driver.activeOrderIds.length,
        );
        await session.saveDriver(driver);
        return driver;
      }

      const orders = await session.findRequests(driver.activeOrderIds);
      const onTheWay = orders
        .filter((order) => order.orderStatus === 'ON_THE_WAY')
        .map((order) => order.orderId);
      if (onTheWay.length > 0) {
        throw new ConflictError(
          'orders-on-the-way',
          'Driver has orders on the way',
          `Cannot go OFFLINE with orders ON_THE_WAY: ${onTheWay.join(', ')}.`,
        );
      }

      const now = this.clock.now();
      driver.availability = 'OFFLINE';
      await session.saveDriver(driver);

      // Release first, then reassign: the driver is OFFLINE now, so the new
      // attempts can only pick other drivers. DriverUnassigned is written to
      // the outbox before the next DriverAssigned of the same order (same key,
      // insertion order), so consumers see them in that order, and each event
      // carries a strictly later time than the previous one (strictlyAfter).
      for (const order of orders) {
        const active = await session.findActiveAssignment(order.orderId);
        const unassignedAt = strictlyAfter(active?.assignedAt, now);
        await this.assigner.release(
          session,
          order.orderId,
          unassignedAt,
          'DRIVER_OFFLINE',
        );
        await session.publish(
          driverUnassigned(
            order.orderId,
            driverId,
            unassignedAt,
            correlationId,
          ),
        );
        order.state = 'PENDING';
        order.driverId = null;
        order.attempts = 0;
        order.windowStartedAt = now;
        order.nextAttemptAt = now;
        await session.saveRequest(order);
        await this.assigner.attempt(
          session,
          order,
          strictlyAfter(unassignedAt, now),
          correlationId,
        );
      }
      if (orders.length > 0) {
        this.logger.log({
          msg: 'Driver went OFFLINE; orders released for reassignment',
          driverId,
          orders: orders.map((o) => o.orderId),
          correlationId,
        });
      }

      driver.activeOrderIds = [];
      return driver;
    });
  }
}

@Injectable()
export class ChangeDriverCapacity {
  constructor(private readonly store: ProfilesStore) {}

  /**
   * `PATCH /drivers/{driverId}/capacity` (role OPERATIONS, spec 4.1).
   * A higher capacity lets waiting orders be assigned at their next attempt.
   *
   * @throws {InvalidInputError} not an integer 1–10 (400).
   * @throws {NotFoundError} unknown driver (404).
   * @throws {ConflictError} lower than the driver's active orders (409).
   */
  async execute(driverId: string, capacity: number): Promise<Driver> {
    return this.store.inAssignmentSession(async (session) => {
      const driver = await session.findDriver(driverId);
      if (!driver)
        throw new NotFoundError('driver', `Driver ${driverId} not found`);

      const problem = checkCapacity(capacity, driver.activeOrderIds.length);
      if (problem === 'OUT_OF_RANGE')
        throw new InvalidInputError(
          'capacity',
          'capacity must be an integer between 1 and 10',
        );
      if (problem === 'BELOW_ACTIVE_ORDERS') {
        throw new ConflictError(
          'capacity-below-active-orders',
          'Capacity lower than active orders',
          `Driver has ${driver.activeOrderIds.length} active orders; capacity ${capacity} is not allowed.`,
        );
      }

      driver.capacity = capacity;
      await session.saveDriver(driver);
      return driver;
    });
  }
}

@Injectable()
export class GetAssignment {
  constructor(private readonly store: ProfilesStore) {}

  /**
   * `GET /assignments?orderId=` (role OPERATIONS): the order's most recent
   * assignment, active or released.
   *
   * @throws {NotFoundError} no assignment yet (404).
   */
  async execute(orderId: string): Promise<Assignment> {
    const assignment = await this.store.findLatestAssignment(orderId);
    if (!assignment)
      throw new NotFoundError(
        'assignment',
        `Order ${orderId} has no assignment yet`,
      );
    return assignment;
  }
}
