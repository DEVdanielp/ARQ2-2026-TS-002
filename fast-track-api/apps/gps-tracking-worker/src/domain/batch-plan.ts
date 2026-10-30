/**
 * The sequencing rule of F2: what to do with the points of one batch.
 *
 * This is the rule that is broken today ("the backend processes them out of
 * order ... a package jumps from Delivered back to On the Way"), so it lives
 * here as a pure function, tested without Kafka or PostgreSQL (ADR-014).
 *
 *   - Points are taken in `sequence` order, never in arrival order (F2-S3).
 *   - A sequence already stored for the driver, or repeated inside the batch,
 *     is ignored: redeliveries and app retries never duplicate history (F2-S4).
 *   - Every NEW sequence is appended to the history, even if it is older than
 *     the last known location (a late point): the history is the audit trail
 *     (ADR-011, ADR-018).
 *   - The last known location only moves FORWARD: to the highest sequence, and
 *     only if it is higher than the current one (F2-S4: "does not move backward").
 */
import type { SequencedPoint } from './tracking.js';

export interface BatchPlan<P extends SequencedPoint> {
  /** Points to append to the history: new sequences, sorted ascending, no duplicates. */
  toStore: P[];
  /**
   * Points newer than the last known location (sequence > lastSequence),
   * sorted ascending. A subset of `toStore`; the NEARBY rule looks at these.
   */
  advancing: P[];
  /** The new last known location (highest advancing point), or null if the location does not move. */
  newLocation: P | null;
  /** Points skipped because their sequence was already stored or repeated in the batch. */
  duplicates: number;
  /** New points older than the last known location: stored, but they do not move it. */
  late: number;
}

/**
 * @param points - the batch, in any order.
 * @param lastSequence - sequence of the current last known location; null if none yet.
 * @param alreadyStored - sequences of this batch that the history already contains.
 */
export function planBatch<P extends SequencedPoint>(
  points: readonly P[],
  lastSequence: number | null,
  alreadyStored: ReadonlySet<number>,
): BatchPlan<P> {
  // Stable sort: for a sequence repeated inside the batch, the first one sent wins.
  const sorted = [...points].sort((a, b) => a.sequence - b.sequence);

  const toStore: P[] = [];
  const seen = new Set<number>();
  for (const point of sorted) {
    if (seen.has(point.sequence) || alreadyStored.has(point.sequence)) continue;
    seen.add(point.sequence);
    toStore.push(point);
  }

  const advancing = toStore.filter((point) => lastSequence === null || point.sequence > lastSequence);
  return {
    toStore,
    advancing,
    newLocation: advancing.at(-1) ?? null,
    duplicates: points.length - toStore.length,
    late: toStore.length - advancing.length,
  };
}

/** The point with the highest sequence (the batch's candidate for the last known location). */
export function latestPoint<P extends SequencedPoint>(points: readonly P[]): P | null {
  return points.reduce<P | null>((latest, point) => (latest === null || point.sequence > latest.sequence ? point : latest), null);
}
