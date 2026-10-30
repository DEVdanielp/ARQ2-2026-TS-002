/**
 * Domain vocabulary of the GPS Tracking Worker (docs/spec.md sections 1 and 3).
 *
 * The domain layer (ADR-014, hexagonal architecture) holds the business
 * concepts and rules and depends on nothing else: no Nest, no TypeORM, no
 * Kafka. Use cases and adapters depend on it, never the other way around.
 */

/** Spec 3 `OrderStatus`. The worker keeps a copy to know which orders it monitors. */
export const OrderStatuses = ['CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = (typeof OrderStatuses)[number];

/** `DELIVERED` and `CANCELLED` are terminal (spec 1, Order lifecycle). */
export function isTerminal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

/** A WGS-84 position in decimal degrees. */
export interface Coordinates {
  lat: number;
  lng: number;
}

/** What the domain needs from a GPS point; the event's `GpsPoint` satisfies it. */
export interface SequencedPoint extends Coordinates {
  /** Monotonic per driver device: THE order of the points (ADR-001). */
  sequence: number;
  deviceTime: string;
}

/**
 * An order the worker monitors for a driver: assigned to them, picked up
 * (`ON_THE_WAY`) and with a known destination. Only these orders get
 * `LocationUpdated` and the NEARBY check (spec 5.4, F5-S1, ADR-018).
 */
export interface MonitoredOrder {
  orderId: string;
  driverId: string;
  destination: Coordinates;
  /** Set once NEARBY fired; it never fires again for the order (F5-S2). */
  nearbyReachedAt: Date | null;
  /** Last call to the ETA provider for this order, to call it at most once per minute (ADR-013). */
  etaCheckedAt: Date | null;
}
