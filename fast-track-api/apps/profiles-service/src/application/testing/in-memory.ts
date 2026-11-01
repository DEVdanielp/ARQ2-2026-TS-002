/**
 * In-memory implementation of the ports, for unit tests only.
 *
 * It behaves like the PostgreSQL adapter where the use cases can notice:
 * - a session is a transaction: if the work throws, every change of the
 *   session is rolled back (including the outbox);
 * - reads return copies, so a use case only changes stored data by saving it;
 * - `activeOrderIds` is derived from the active assignments, as in SQL;
 * - `markProcessed` answers false for an eventId already seen.
 */
import type { OutboxMessage } from '@libs/outbox';
import type {
  Assignment,
  AssignmentRequest,
  Customer,
  Driver,
  ReleaseReason,
} from '../../domain/profiles.js';
import {
  Clock,
  ProfilesStore,
  type AssignmentSession,
  type CustomerSession,
} from '../ports.js';

type StoredDriver = Omit<Driver, 'activeOrderIds'>;

interface State {
  customers: Map<string, Customer>;
  drivers: Map<string, StoredDriver>;
  requests: Map<string, AssignmentRequest>;
  assignments: Assignment[];
  processed: Set<string>;
  outbox: OutboxMessage[];
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryProfilesStore extends ProfilesStore {
  state: State = {
    customers: new Map(),
    drivers: new Map(),
    requests: new Map(),
    assignments: [],
    processed: new Set(),
    outbox: [],
  };

  /** Events written to the outbox, in order (what the relay would publish). */
  get published(): OutboxMessage[] {
    return this.state.outbox;
  }

  publishedTypes(): string[] {
    return this.state.outbox.map((message) => message.envelope.eventType);
  }

  async inCustomerSession<T>(
    customerId: string,
    work: (session: CustomerSession) => Promise<T>,
  ): Promise<T> {
    return this.transaction(() =>
      work({
        current: this.state.customers.has(customerId)
          ? copy(this.state.customers.get(customerId)!)
          : null,
        save: async (customer) =>
          void this.state.customers.set(customer.customerId, copy(customer)),
        publish: async (message) => void this.state.outbox.push(message),
      }),
    );
  }

  async inAssignmentSession<T>(
    work: (session: AssignmentSession) => Promise<T>,
  ): Promise<T> {
    const s = this.state;
    const session: AssignmentSession = {
      markProcessed: async (eventId) => {
        if (s.processed.has(eventId)) return false;
        s.processed.add(eventId);
        return true;
      },
      findDriver: async (driverId) => this.driver(driverId),
      findAssignableDrivers: async () =>
        [...s.drivers.values()]
          .filter((d) => d.availability !== 'OFFLINE')
          .map((d) => this.driver(d.driverId)!),
      saveDriver: async ({ activeOrderIds: _derived, ...driver }) =>
        void s.drivers.set(driver.driverId, copy(driver)),
      findRequest: async (orderId) =>
        s.requests.has(orderId) ? copy(s.requests.get(orderId)!) : null,
      findRequests: async (orderIds) =>
        orderIds
          .filter((id) => s.requests.has(id))
          .map((id) => copy(s.requests.get(id)!)),
      findDueRequests: async (now, limit) =>
        [...s.requests.values()]
          .filter(
            (r) =>
              r.state === 'PENDING' &&
              r.orderStatus === 'CREATED' &&
              r.nextAttemptAt !== null &&
              r.nextAttemptAt <= now,
          )
          .sort(
            (a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime(),
          )
          .slice(0, limit)
          .map(copy),
      saveRequest: async (request) =>
        void s.requests.set(request.orderId, copy(request)),
      findActiveAssignment: async (orderId) =>
        copy(this.active(orderId) ?? null),
      openAssignment: async (orderId, driverId, at) => {
        if (this.active(orderId))
          throw new Error(
            `Order ${orderId} already has an active assignment (unique index)`,
          );
        s.assignments.push({
          orderId,
          driverId,
          assignedAt: at,
          releasedAt: null,
          releaseReason: null,
        });
      },
      releaseAssignment: async (orderId, at, reason: ReleaseReason) => {
        const active = this.active(orderId);
        if (active)
          Object.assign(active, { releasedAt: at, releaseReason: reason });
      },
      publish: async (message) => void s.outbox.push(message),
    };
    return this.transaction(() => work(session));
  }

  async findCustomer(customerId: string) {
    return this.state.customers.has(customerId)
      ? copy(this.state.customers.get(customerId)!)
      : null;
  }

  async findLatestAssignment(orderId: string) {
    const rows = this.state.assignments.filter((a) => a.orderId === orderId);
    return rows.length ? copy(rows[rows.length - 1]) : null;
  }

  // ------------------------------------------------------------ test helpers

  /** A driver as it would be read from the database (with derived activeOrderIds). */
  driver(driverId: string): Driver | null {
    const stored = this.state.drivers.get(driverId);
    if (!stored) return null;
    const activeOrderIds = this.state.assignments
      .filter((a) => a.driverId === driverId && a.releasedAt === null)
      .map((a) => a.orderId);
    return { ...copy(stored), activeOrderIds };
  }

  request(orderId: string): AssignmentRequest | null {
    return this.state.requests.has(orderId)
      ? copy(this.state.requests.get(orderId)!)
      : null;
  }

  /** Inserts a driver directly (test setup). */
  addDriver(driver: Partial<Driver> & Pick<Driver, 'driverId'>): void {
    const { activeOrderIds: _ignored, ...rest } = driver;
    this.state.drivers.set(driver.driverId, {
      name: `Driver ${driver.driverId}`,
      phone: '+573100000000',
      vehiclePlate: 'ABC123',
      availability: 'AVAILABLE',
      capacity: 3,
      lastAssignedAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...rest,
    });
  }

  private active(orderId: string): Assignment | undefined {
    return this.state.assignments.find(
      (a) => a.orderId === orderId && a.releasedAt === null,
    );
  }

  /** Runs `work`; if it throws, restores the state from before it started. */
  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    const snapshot = copy(this.state);
    try {
      return await work();
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }
}

/** A clock the test moves by hand. */
export class FakeClock extends Clock {
  constructor(private current: Date = new Date('2026-10-18T15:00:00Z')) {
    super();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
