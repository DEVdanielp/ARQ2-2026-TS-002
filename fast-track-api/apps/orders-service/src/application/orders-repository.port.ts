import type {
  AuthenticatedUser,
  IntentInput,
  Order,
  OrderStatus,
  StoredResponse,
} from '../domain/order.js';

export const ORDERS_REPOSITORY = Symbol('ORDERS_REPOSITORY');

export interface CreateOrderInput {
  customerId: string;
  destination: Order['destination'];
  notes?: string;
}

export interface ListOrdersInput {
  status?: OrderStatus;
  page: number;
  size: number;
}

export interface OrdersRepository {
  createOrder(
    input: CreateOrderInput,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Order>>;
  getOrder(orderId: string): Promise<Order | null>;
  findIdempotentResponse(
    ownerId: string,
    scope: string,
    key: string | undefined,
    input: unknown,
  ): Promise<StoredResponse<Record<string, unknown>> | null>;
  listOrders(
    user: AuthenticatedUser,
    query: ListOrdersInput,
  ): Promise<{ items: Order[]; page: number; size: number; total: number }>;
  queueIntent(
    order: Order,
    user: AuthenticatedUser,
    intent: IntentInput,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<StoredResponse<Record<string, unknown>>>;
}
