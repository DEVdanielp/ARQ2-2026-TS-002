/**
 * What the API returns for an order (spec 3 `Order`). It lives here and not in
 * the HTTP adapter because idempotent responses are stored as they were sent.
 * `notes` is kept in orders-db but is not part of the spec's `Order`.
 */
import type {
  Cancellation,
  Destination,
  Order,
  OrderStatus,
} from '../domain/order.js';

export interface OrderView {
  orderId: string;
  customerId: string;
  driverId: string | null;
  destination: Destination;
  status: OrderStatus;
  version: number;
  cancellation: Cancellation | null;
  createdAt: string;
  updatedAt: string;
}

export function orderView(order: Order): OrderView {
  return {
    orderId: order.orderId,
    customerId: order.customerId,
    driverId: order.driverId,
    destination: order.destination,
    status: order.status,
    version: order.version,
    cancellation: order.cancellation,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
