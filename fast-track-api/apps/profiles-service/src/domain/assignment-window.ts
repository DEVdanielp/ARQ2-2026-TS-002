/**
 * The assignment window of the saga (spec 1 "Failure paths", F1-S3, F1-S3b,
 * ADR-016): when no driver is available, Profiles retries every 30 seconds;
 * if no driver was assigned 10 minutes after the window started, it gives up
 * and publishes `AssignmentFailed`. The order stays CREATED.
 *
 * Both durations are configurable (ASSIGNMENT_RETRY_SECONDS,
 * ASSIGNMENT_WINDOW_SECONDS) so the whole flow can be watched in seconds
 * locally; the defaults are the spec's.
 */
import type { AssignmentRequest } from './profiles.js';

export const DEFAULT_RETRY_SECONDS = 30;
export const DEFAULT_WINDOW_SECONDS = 600;

/**
 * Time to stamp on an assignment event so it is STRICTLY later than the
 * previous assignment event of the same order.
 *
 * Consumers order `DriverAssigned` / `DriverUnassigned` / `AssignmentFailed`
 * of one order by these timestamps and drop an event that is not newer than
 * the last one applied (Tracking Query does `at <= assignmentAt -> ignore`).
 * When two of them are written in the same transaction (a driver goes OFFLINE
 * and the order is reassigned at once) they would share `now`, so the second
 * one is moved 1 ms later.
 */
export function strictlyAfter(
  previous: Date | null | undefined,
  now: Date,
): Date {
  if (previous && previous.getTime() >= now.getTime()) {
    return new Date(previous.getTime() + 1);
  }
  return now;
}

export class AssignmentWindow {
  constructor(
    readonly retrySeconds: number = DEFAULT_RETRY_SECONDS,
    readonly windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  ) {}

  /** True once the window is over: the next due attempt publishes AssignmentFailed instead. */
  isExpired(
    request: Pick<AssignmentRequest, 'windowStartedAt'>,
    now: Date,
  ): boolean {
    return (
      now.getTime() - request.windowStartedAt.getTime() >=
      this.windowSeconds * 1000
    );
  }

  /** When to try again after an attempt that found no driver. */
  nextAttemptAfter(now: Date): Date {
    return new Date(now.getTime() + this.retrySeconds * 1000);
  }
}
