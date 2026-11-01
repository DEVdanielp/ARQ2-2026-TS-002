/**
 * Driver rules of F1: who can receive an order, which driver is chosen, and
 * how availability follows the active orders (spec 4.1, F1-S2, F1-S4, F1-S5,
 * ADR-019).
 *
 * Pure functions: the use cases call them with data already loaded (and
 * locked) by the persistence adapter, so every rule is unit-tested without a
 * database.
 */
import {
  MAX_CAPACITY,
  MIN_CAPACITY,
  type Driver,
  type DriverAvailability,
} from './profiles.js';

/** Number of free slots: capacity minus active orders (never negative). */
export function freeSlots(
  driver: Pick<Driver, 'capacity' | 'activeOrderIds'>,
): number {
  return Math.max(0, driver.capacity - driver.activeOrderIds.length);
}

/**
 * A driver can receive a new order when they are not OFFLINE and have a free
 * slot (F1-S2, F1-S4). `EN_ROUTE` drivers are eligible too: capacity (1–10)
 * is the number of concurrent orders, so it would mean nothing if a driver
 * with one order could never get a second (ADR-019).
 */
export function isEligible(
  driver: Pick<Driver, 'availability' | 'capacity' | 'activeOrderIds'>,
): boolean {
  return driver.availability !== 'OFFLINE' && freeSlots(driver) > 0;
}

/**
 * Chooses the driver for a new order among the candidates (ADR-019):
 *   1. only eligible drivers;
 *   2. fewest active orders first, so work is spread;
 *   3. tie: the one whose last assignment is oldest (never assigned first),
 *      so nobody waits forever;
 *   4. tie: lowest driverId, so the result is deterministic.
 *
 * Profiles has no driver location (it lives in the GPS service and services
 * never query each other, spec 1), so distance is not part of the rule.
 *
 * @returns the chosen driver, or null if nobody is eligible (F1-S3).
 */
export function chooseDriver<T extends Driver>(
  candidates: readonly T[],
): T | null {
  const eligible = candidates.filter(isEligible);
  if (eligible.length === 0) return null;

  return [...eligible].sort((a, b) => {
    const byLoad = a.activeOrderIds.length - b.activeOrderIds.length;
    if (byLoad !== 0) return byLoad;
    const byWait = compareLastAssigned(a.lastAssignedAt, b.lastAssignedAt);
    if (byWait !== 0) return byWait;
    return a.driverId.localeCompare(b.driverId);
  })[0];
}

/** Never assigned (null) first, then the oldest last assignment. */
function compareLastAssigned(a: Date | null, b: Date | null): number {
  if (a === null || b === null)
    return (a === null ? 0 : 1) - (b === null ? 0 : 1);
  return a.getTime() - b.getTime();
}

/**
 * Availability after the active orders changed (F1-S5): a driver who is not
 * OFFLINE is EN_ROUTE while they have active orders and AVAILABLE when they
 * have none. OFFLINE is only changed by the driver.
 */
export function availabilityFor(
  current: DriverAvailability,
  activeOrders: number,
): DriverAvailability {
  if (current === 'OFFLINE') return 'OFFLINE';
  return activeOrders > 0 ? 'EN_ROUTE' : 'AVAILABLE';
}

/** Why a capacity change is refused. */
export type CapacityProblem = 'OUT_OF_RANGE' | 'BELOW_ACTIVE_ORDERS';

/**
 * Checks `PATCH /drivers/{driverId}/capacity` (spec 4.1): 1–10 (400), and not
 * lower than the current active orders (409).
 */
export function checkCapacity(
  capacity: number,
  activeOrders: number,
): CapacityProblem | null {
  if (
    !Number.isInteger(capacity) ||
    capacity < MIN_CAPACITY ||
    capacity > MAX_CAPACITY
  )
    return 'OUT_OF_RANGE';
  if (capacity < activeOrders) return 'BELOW_ACTIVE_ORDERS';
  return null;
}
