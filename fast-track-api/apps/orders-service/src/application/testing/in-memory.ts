/**
 * In-memory fakes of the ports, for unit tests. A session works on a copy of
 * the state, replaced only if the work succeeds, so a failed use case leaves
 * nothing behind: the same all-or-nothing a database transaction gives.
 */
import type { EventEnvelope } from '@libs/events';
import type { OutboxMessage } from '@libs/outbox';
import type { Order } from '../../domain/order.js';
import { ServiceUnavailableError } from '../errors.js';
import {
  Clock,
  IntentPublisher,
  OrdersStore,
  type IdempotencyScope,
  type OrderFilter,
  type OrderPage,
  type OrderSession,
  type RejectedIntent,
  type StoredResponse,
} from '../ports.js';

export class FakeClock extends Clock {
  constructor(public current = new Date('2026-10-18T15:00:00Z')) {
    super();
  }

  now(): Date {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

interface StoredKey {
  response: StoredResponse;
  expiresAt: Date;
}

interface State {
  orders: Map<string, Order>;
  processed: Set<string>;
  keys: Map<string, StoredKey>;
  rejected: RejectedIntent[];
  outbox: OutboxMessage[];
}

const keyOf = (target: IdempotencyScope): string =>
  `${target.ownerId}|${target.scope}|${target.key}`;

export class InMemoryOrdersStore extends OrdersStore {
  private state: State = {
    orders: new Map(),
    processed: new Set(),
    keys: new Map(),
    rejected: [],
    outbox: [],
  };

  get outbox(): OutboxMessage[] {
    return this.state.outbox;
  }

  get rejected(): RejectedIntent[] {
    return this.state.rejected;
  }

  /** Puts an order in the store directly, as a test's starting point. */
  seed(order: Order): void {
    this.state.orders.set(order.orderId, order);
  }

  eventsOfType(eventType: string): OutboxMessage[] {
    return this.outbox.filter(
      (message) => message.envelope.eventType === eventType,
    );
  }

  async inSession<T>(work: (session: OrderSession) => Promise<T>): Promise<T> {
    const copy: State = {
      orders: new Map(this.state.orders),
      processed: new Set(this.state.processed),
      keys: new Map(this.state.keys),
      rejected: [...this.state.rejected],
      outbox: [...this.state.outbox],
    };
    const result = await work(sessionOver(copy));
    this.state = copy;
    return result;
  }

  async findOrder(orderId: string): Promise<Order | null> {
    return this.state.orders.get(orderId) ?? null;
  }

  async listOrders(
    filter: OrderFilter,
    page: number,
    size: number,
  ): Promise<OrderPage> {
    const scoped = filter.customerId || filter.driverId;
    const matches = [...this.state.orders.values()]
      .filter(
        (order) =>
          !scoped ||
          order.customerId === filter.customerId ||
          order.driverId === filter.driverId,
      )
      .filter((order) => !filter.status || order.status === filter.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: matches.slice(page * size, (page + 1) * size),
      total: matches.length,
    };
  }

  async purgeExpired(now: Date): Promise<void> {
    for (const [key, stored] of this.state.keys) {
      if (stored.expiresAt <= now) this.state.keys.delete(key);
    }
  }

  get keyCount(): number {
    return this.state.keys.size;
  }
}

function sessionOver(state: State): OrderSession {
  return {
    async markProcessed(eventId) {
      if (state.processed.has(eventId)) return false;
      state.processed.add(eventId);
      return true;
    },
    async findOrder(orderId) {
      return state.orders.get(orderId) ?? null;
    },
    async lockOrder(orderId) {
      return state.orders.get(orderId) ?? null;
    },
    async insertOrder(order) {
      state.orders.set(order.orderId, order);
    },
    async updateOrder(order) {
      state.orders.set(order.orderId, order);
    },
    async recordRejectedIntent(rejected) {
      state.rejected.push(rejected);
    },
    async lockIdempotencyKey() {},
    async findResponse(target, now) {
      const stored = state.keys.get(keyOf(target));
      return stored && stored.expiresAt > now ? stored.response : null;
    },
    async saveResponse(target, response, expiresAt) {
      state.keys.set(keyOf(target), { response, expiresAt });
    },
    async publish(message) {
      state.outbox.push(message);
    },
  };
}

export class FakeIntentPublisher extends IntentPublisher {
  readonly published: EventEnvelope[] = [];
  failing = false;

  async publish(_orderId: string, envelope: EventEnvelope): Promise<void> {
    if (this.failing) throw new ServiceUnavailableError('Kafka');
    this.published.push(envelope);
  }
}
