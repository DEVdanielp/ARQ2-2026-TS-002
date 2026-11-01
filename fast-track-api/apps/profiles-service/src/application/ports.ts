/**
 * Ports: what the use cases need from the outside world (ADR-014).
 *
 * The application layer declares these abstract classes; the adapters
 * implement them (PostgreSQL through TypeORM + the outbox). Use cases depend
 * only on these declarations, so they are tested with in-memory fakes
 * (application/testing/in-memory.ts).
 *
 * They are abstract classes (not interfaces) because Nest needs a runtime
 * token to inject an implementation.
 *
 * Transactions as "sessions"
 * --------------------------
 * Every write happens inside a session: one database transaction in which the
 * use case reads, decides (domain rules) and writes, and in which the events
 * are written to the outbox (ADR-005). Everything done through a session
 * commits together or not at all. Same idea as the GPS Tracking Worker's
 * `DriverTrackingSession`.
 *
 * - `CustomerSession`: one customer, locked until commit.
 * - `AssignmentSession`: drivers, orders and assignments. Assignment sessions
 *   run one at a time (ADR-019), so two of them can never give the last free
 *   slot of a driver to two orders.
 */
import type { OutboxMessage } from '@libs/outbox';
import type { AssignmentWindow } from '../domain/assignment-window.js';
import type {
  Assignment,
  AssignmentRequest,
  Customer,
  Driver,
  ReleaseReason,
} from '../domain/profiles.js';

// ---------------------------------------------------------------- sessions

export interface CustomerSession {
  /** The customer as stored before this transaction; null if the profile does not exist yet. */
  readonly current: Customer | null;
  /** Inserts or updates the customer. */
  save(customer: Customer): Promise<void>;
  /** Writes an event to the outbox, in this transaction. */
  publish(message: OutboxMessage): Promise<void>;
}

export interface AssignmentSession {
  /**
   * Records that this consumed event was handled (table `processed_events`).
   * @returns false if it was already handled: the caller must stop (ADR-009).
   */
  markProcessed(eventId: string, eventType: string): Promise<boolean>;

  /** The driver with their `activeOrderIds`; null if the profile does not exist. */
  findDriver(driverId: string): Promise<Driver | null>;
  /** Every driver that is not OFFLINE, with their active orders: the candidates of `chooseDriver`. */
  findAssignableDrivers(): Promise<Driver[]>;
  /** Inserts or updates the driver's own columns (`activeOrderIds` is derived from `assignments`). */
  saveDriver(driver: Driver): Promise<void>;

  findRequest(orderId: string): Promise<AssignmentRequest | null>;
  findRequests(orderIds: readonly string[]): Promise<AssignmentRequest[]>;
  /** PENDING requests of CREATED orders whose next attempt is due, oldest first. */
  findDueRequests(now: Date, limit: number): Promise<AssignmentRequest[]>;
  saveRequest(request: AssignmentRequest): Promise<void>;

  /** The active (not released) assignment of an order, if any. */
  findActiveAssignment(orderId: string): Promise<Assignment | null>;
  openAssignment(orderId: string, driverId: string, at: Date): Promise<void>;
  releaseAssignment(
    orderId: string,
    at: Date,
    reason: ReleaseReason,
  ): Promise<void>;

  /** Writes an event to the outbox, in this transaction. */
  publish(message: OutboxMessage): Promise<void>;
}

// ---------------------------------------------------------------- store

export abstract class ProfilesStore {
  /** Runs `work` in one transaction that holds the customer's lock (even if the profile does not exist yet). */
  abstract inCustomerSession<T>(
    customerId: string,
    work: (session: CustomerSession) => Promise<T>,
  ): Promise<T>;
  /** Runs `work` in one transaction, serialized with every other assignment session (ADR-019). */
  abstract inAssignmentSession<T>(
    work: (session: AssignmentSession) => Promise<T>,
  ): Promise<T>;

  // Read-only queries (no transaction needed).
  abstract findCustomer(customerId: string): Promise<Customer | null>;
  /** Most recent assignment of the order (active or released); null if it never had one. */
  abstract findLatestAssignment(orderId: string): Promise<Assignment | null>;
}

// ---------------------------------------------------------------- time and settings

/** Current time, injectable so tests can move it (the 30 s / 10 min window). */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Business settings read from the environment. */
export class AssignmentSettings {
  constructor(
    /** Retry every 30 s for up to 10 min (spec 1, F1-S3, F1-S3b). */
    readonly window: AssignmentWindow,
    /** Capacity of a new driver profile (spec 4.1 example: 3). */
    readonly defaultDriverCapacity: number,
    /** How many due orders one scheduler tick handles at most. */
    readonly dueBatchSize: number = 50,
  ) {}
}
