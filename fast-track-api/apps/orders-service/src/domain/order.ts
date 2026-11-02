export const ORDER_STATUSES = [
  'CREATED',
  'ON_THE_WAY',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type UserRole = 'CUSTOMER' | 'DRIVER' | 'OPERATIONS';
export type IntentType =
  | 'PICKUP_CONFIRMED'
  | 'DELIVERY_CONFIRMED'
  | 'CANCELLATION_REQUESTED';

export interface AuthenticatedUser {
  id: string;
  roles: UserRole[];
}

export interface Location {
  lat: number;
  lng: number;
}

export interface Destination {
  address: string;
  location: Location;
}

export interface Order {
  orderId: string;
  customerId: string;
  driverId: string | null;
  destination: Destination;
  notes?: string;
  status: OrderStatus;
  version: number;
  cancellation: { actor: UserRole | 'SYSTEM'; reason?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntentInput {
  type: IntentType;
  reason?: string;
}

export interface StoredResponse<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
