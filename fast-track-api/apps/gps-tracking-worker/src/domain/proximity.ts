/**
 * The NEARBY rule of F5-S1 (spec 5.4 `DriverNearDestination`, ADR-013):
 * the driver is near when the straight-line distance to the destination is
 * under 500 m (`DISTANCE`) or the provider's ETA is under 300 s (`ETA`).
 * Thresholds come from the environment (NEARBY_DISTANCE_METERS, NEARBY_ETA_SECONDS).
 */
import type { Coordinates, SequencedPoint } from './tracking.js';

export type ProximityTrigger = 'DISTANCE' | 'ETA';

export interface ProximityThresholds {
  /** Spec: 500 m. */
  distanceMeters: number;
  /** Spec: 300 s. */
  etaSeconds: number;
}

export interface ProximityDetection<P extends SequencedPoint> {
  trigger: ProximityTrigger;
  /** The point that triggered it. */
  point: P;
  distanceMeters: number;
  etaSeconds: number | null;
}

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres: the "straight line" of ADR-013. */
export function distanceMeters(from: Coordinates, to: Coordinates): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Looks for the FIRST point, in sequence order, that puts the driver near the
 * destination. Every new point counts, not only the last one: a driver who
 * passed within 500 m while offline still triggers NEARBY once the backlog
 * arrives.
 *
 * @param points - the batch's advancing points, sorted by sequence.
 * @param etaForLast - ETA in seconds from the last point, if the provider was
 *   consulted (ADR-013 only calls it for the latest position); null otherwise.
 */
export function detectProximity<P extends SequencedPoint>(
  destination: Coordinates,
  points: readonly P[],
  thresholds: ProximityThresholds,
  etaForLast: number | null,
): ProximityDetection<P> | null {
  const last = points.at(-1);
  for (const point of points) {
    const distance = distanceMeters(point, destination);
    if (distance < thresholds.distanceMeters) {
      return { trigger: 'DISTANCE', point, distanceMeters: distance, etaSeconds: point === last ? etaForLast : null };
    }
  }
  if (last && etaForLast !== null && etaForLast < thresholds.etaSeconds) {
    return { trigger: 'ETA', point: last, distanceMeters: distanceMeters(last, destination), etaSeconds: etaForLast };
  }
  return null;
}
