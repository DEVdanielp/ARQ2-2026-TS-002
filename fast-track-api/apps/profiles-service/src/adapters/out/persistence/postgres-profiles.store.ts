/**
 * PostgreSQL implementation of `ProfilesStore` (application/ports.ts).
 *
 * Plain SQL through TypeORM's EntityManager, like the GPS Tracking Worker:
 * the rules rely on locks, `ON CONFLICT` and partial unique indexes, which
 * read more clearly as SQL than as entity mappings.
 *
 * Concurrency (ADR-019)
 * ---------------------
 * - Assignment sessions take ONE transaction-level advisory lock, so they run
 *   one at a time: the last free slot of a driver can never go to two orders,
 *   and no deadlock is possible between orders and drivers. Profiles is the
 *   low-volume service of the system (ADR-003), so this costs nothing
 *   noticeable; with more volume it can become a per-driver lock.
 * - Customer sessions lock only their customer (an advisory lock on the id,
 *   which works even before the row exists), so two concurrent PUTs can never
 *   publish the same contact version.
 * Advisory locks are released automatically at commit or rollback.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { OutboxService, type OutboxMessage } from '@libs/outbox';
import type {
  Assignment,
  AssignmentRequest,
  AssignmentState,
  Customer,
  Driver,
  DriverAvailability,
  OrderStatus,
  ReleaseReason,
} from '../../../domain/profiles.js';
import {
  ProfilesStore,
  type AssignmentSession,
  type CustomerSession,
} from '../../../application/ports.js';

/** Advisory lock namespaces (two-int form: (namespace, key)). */
const ASSIGNMENT_LOCK = 'SELECT pg_advisory_xact_lock(1901, 0)';
const CUSTOMER_LOCK = 'SELECT pg_advisory_xact_lock(1902, hashtext($1))';

// ---------------------------------------------------------------- row mapping

interface CustomerRow {
  customer_id: string;
  name: string;
  email: string;
  phone: string | null;
  contact_version: number;
  created_at: Date;
  updated_at: Date;
}

const toCustomer = (row: CustomerRow): Customer => ({
  customerId: row.customer_id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  contactVersion: row.contact_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface DriverRow {
  driver_id: string;
  name: string;
  phone: string;
  vehicle_plate: string;
  availability: DriverAvailability;
  capacity: number;
  last_assigned_at: Date | null;
  created_at: Date;
  active_order_ids: string[];
}

/** Drivers with their active orders, derived from `assignments` (never stored twice). */
const DRIVERS_SQL = `
  SELECT d.driver_id, d.name, d.phone, d.vehicle_plate, d.availability, d.capacity, d.last_assigned_at, d.created_at,
         COALESCE(array_agg(a.order_id::text ORDER BY a.assigned_at, a.order_id) FILTER (WHERE a.order_id IS NOT NULL), '{}') AS active_order_ids
    FROM drivers d
    LEFT JOIN assignments a ON a.driver_id = d.driver_id AND a.released_at IS NULL`;

const toDriver = (row: DriverRow): Driver => ({
  driverId: row.driver_id,
  name: row.name,
  phone: row.phone,
  vehiclePlate: row.vehicle_plate,
  availability: row.availability,
  capacity: row.capacity,
  activeOrderIds: row.active_order_ids,
  lastAssignedAt: row.last_assigned_at,
  createdAt: row.created_at,
});

interface RequestRow {
  order_id: string;
  customer_id: string;
  destination_address: string | null;
  destination_lat: number;
  destination_lng: number;
  order_status: OrderStatus;
  order_version: number;
  state: AssignmentState;
  driver_id: string | null;
  attempts: number;
  window_started_at: Date;
  next_attempt_at: Date | null;
  correlation_id: string;
}

const toRequest = (row: RequestRow): AssignmentRequest => ({
  orderId: row.order_id,
  customerId: row.customer_id,
  destination: {
    address: row.destination_address,
    location: { lat: row.destination_lat, lng: row.destination_lng },
  },
  orderStatus: row.order_status,
  orderVersion: row.order_version,
  state: row.state,
  driverId: row.driver_id,
  attempts: row.attempts,
  windowStartedAt: row.window_started_at,
  nextAttemptAt: row.next_attempt_at,
  correlationId: row.correlation_id,
});

interface AssignmentRow {
  order_id: string;
  driver_id: string;
  assigned_at: Date;
  released_at: Date | null;
  release_reason: ReleaseReason | null;
}

const toAssignment = (row: AssignmentRow): Assignment => ({
  orderId: row.order_id,
  driverId: row.driver_id,
  assignedAt: row.assigned_at,
  releasedAt: row.released_at,
  releaseReason: row.release_reason,
});

// ---------------------------------------------------------------- sessions

class PostgresAssignmentSession implements AssignmentSession {
  constructor(
    private readonly manager: EntityManager,
    private readonly outbox: OutboxService,
  ) {}

  async markProcessed(eventId: string, eventType: string): Promise<boolean> {
    const rows: unknown[] = await this.manager.query(
      `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, eventType],
    );
    return rows.length > 0;
  }

  async findDriver(driverId: string): Promise<Driver | null> {
    const rows: DriverRow[] = await this.manager.query(
      `${DRIVERS_SQL} WHERE d.driver_id = $1 GROUP BY d.driver_id`,
      [driverId],
    );
    return rows.length ? toDriver(rows[0]) : null;
  }

  async findAssignableDrivers(): Promise<Driver[]> {
    const rows: DriverRow[] = await this.manager.query(
      `${DRIVERS_SQL} WHERE d.availability <> 'OFFLINE' GROUP BY d.driver_id ORDER BY d.driver_id`,
    );
    return rows.map(toDriver);
  }

  async saveDriver(driver: Driver): Promise<void> {
    await this.manager.query(
      `INSERT INTO drivers (driver_id, name, phone, vehicle_plate, availability, capacity, last_assigned_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (driver_id) DO UPDATE
          SET name = EXCLUDED.name, phone = EXCLUDED.phone, vehicle_plate = EXCLUDED.vehicle_plate,
              availability = EXCLUDED.availability, capacity = EXCLUDED.capacity,
              last_assigned_at = EXCLUDED.last_assigned_at, updated_at = now()`,
      [
        driver.driverId,
        driver.name,
        driver.phone,
        driver.vehiclePlate,
        driver.availability,
        driver.capacity,
        driver.lastAssignedAt,
        driver.createdAt,
      ],
    );
  }

  async findRequest(orderId: string): Promise<AssignmentRequest | null> {
    const rows: RequestRow[] = await this.manager.query(
      `SELECT * FROM assignment_requests WHERE order_id = $1`,
      [orderId],
    );
    return rows.length ? toRequest(rows[0]) : null;
  }

  async findRequests(
    orderIds: readonly string[],
  ): Promise<AssignmentRequest[]> {
    if (orderIds.length === 0) return [];
    const rows: RequestRow[] = await this.manager.query(
      `SELECT * FROM assignment_requests WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
      [orderIds],
    );
    return rows.map(toRequest);
  }

  async findDueRequests(
    now: Date,
    limit: number,
  ): Promise<AssignmentRequest[]> {
    const rows: RequestRow[] = await this.manager.query(
      `SELECT * FROM assignment_requests
        WHERE state = 'PENDING' AND order_status = 'CREATED' AND next_attempt_at <= $1
        ORDER BY next_attempt_at, order_id
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toRequest);
  }

  async saveRequest(r: AssignmentRequest): Promise<void> {
    await this.manager.query(
      `INSERT INTO assignment_requests (order_id, customer_id, destination_address, destination_lat, destination_lng,
                                        order_status, order_version, state, driver_id, attempts, window_started_at,
                                        next_attempt_at, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (order_id) DO UPDATE
          SET order_status = EXCLUDED.order_status, order_version = EXCLUDED.order_version, state = EXCLUDED.state,
              driver_id = EXCLUDED.driver_id, attempts = EXCLUDED.attempts, window_started_at = EXCLUDED.window_started_at,
              next_attempt_at = EXCLUDED.next_attempt_at, updated_at = now()`,
      [
        r.orderId,
        r.customerId,
        r.destination.address,
        r.destination.location.lat,
        r.destination.location.lng,
        r.orderStatus,
        r.orderVersion,
        r.state,
        r.driverId,
        r.attempts,
        r.windowStartedAt,
        r.nextAttemptAt,
        r.correlationId,
      ],
    );
  }

  async findActiveAssignment(orderId: string): Promise<Assignment | null> {
    const rows: AssignmentRow[] = await this.manager.query(
      `SELECT order_id, driver_id, assigned_at, released_at, release_reason FROM assignments WHERE order_id = $1 AND released_at IS NULL`,
      [orderId],
    );
    return rows.length ? toAssignment(rows[0]) : null;
  }

  async openAssignment(
    orderId: string,
    driverId: string,
    at: Date,
  ): Promise<void> {
    // The partial UNIQUE index rejects a second active assignment of the order.
    await this.manager.query(
      `INSERT INTO assignments (order_id, driver_id, assigned_at) VALUES ($1, $2, $3)`,
      [orderId, driverId, at],
    );
  }

  async releaseAssignment(
    orderId: string,
    at: Date,
    reason: ReleaseReason,
  ): Promise<void> {
    await this.manager.query(
      `UPDATE assignments SET released_at = $2, release_reason = $3 WHERE order_id = $1 AND released_at IS NULL`,
      [orderId, at, reason],
    );
  }

  async publish(message: OutboxMessage): Promise<void> {
    // Same transaction as the changes the event describes (ADR-005).
    await this.outbox.enqueue(this.manager, message);
  }
}

// ---------------------------------------------------------------- store

@Injectable()
export class PostgresProfilesStore extends ProfilesStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  inCustomerSession<T>(
    customerId: string,
    work: (session: CustomerSession) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(CUSTOMER_LOCK, [customerId]);
      const rows: CustomerRow[] = await manager.query(
        `SELECT * FROM customers WHERE customer_id = $1`,
        [customerId],
      );
      return work({
        current: rows.length ? toCustomer(rows[0]) : null,
        save: async (c) => {
          await manager.query(
            `INSERT INTO customers (customer_id, name, email, phone, contact_version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (customer_id) DO UPDATE
                SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
                    contact_version = EXCLUDED.contact_version, updated_at = EXCLUDED.updated_at`,
            [
              c.customerId,
              c.name,
              c.email,
              c.phone,
              c.contactVersion,
              c.createdAt,
              c.updatedAt,
            ],
          );
        },
        publish: (message) => this.outbox.enqueue(manager, message),
      });
    });
  }

  inAssignmentSession<T>(
    work: (session: AssignmentSession) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(ASSIGNMENT_LOCK);
      return work(new PostgresAssignmentSession(manager, this.outbox));
    });
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    const rows: CustomerRow[] = await this.dataSource.query(
      `SELECT * FROM customers WHERE customer_id = $1`,
      [customerId],
    );
    return rows.length ? toCustomer(rows[0]) : null;
  }

  async findLatestAssignment(orderId: string): Promise<Assignment | null> {
    // The active one if it exists, otherwise the most recent.
    const rows: AssignmentRow[] = await this.dataSource.query(
      `SELECT order_id, driver_id, assigned_at, released_at, release_reason FROM assignments
        WHERE order_id = $1
        ORDER BY (released_at IS NULL) DESC, assigned_at DESC
        LIMIT 1`,
      [orderId],
    );
    return rows.length ? toAssignment(rows[0]) : null;
  }
}
