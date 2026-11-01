/**
 * Inbound adapter driven by time: runs `RetryDueAssignments` every
 * ASSIGNMENT_SCHEDULER_INTERVAL_MS (1 s by default).
 *
 * Why a timer that polls the database (and not one timer per order)
 * ------------------------------------------------------------------
 * The due time of every attempt is stored in `assignment_requests.next_attempt_at`.
 * The timer only asks "is anything due?", so a restart loses nothing: pending
 * retries and the 10-minute deadlines (F1-S3, F1-S3b) are database rows, the
 * same idea as the outbox relay (ADR-005, ADR-017).
 *
 * Ticks never overlap: if one is still running when the next fires, the next
 * is skipped. A failing tick is logged and retried on the next one.
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RetryDueAssignments } from '../../../application/assignment.use-cases.js';

export class SchedulerSettings {
  constructor(readonly intervalMs: number) {}
}

@Injectable()
export class AssignmentRetryScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AssignmentRetryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly retryDue: RetryDueAssignments,
    private readonly settings: SchedulerSettings,
  ) {}

  /** Starts after every module is initialised (database migrated, outbox ready). */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.settings.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass over the due orders. Public for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const counts = await this.retryDue.execute();
      if (counts.ASSIGNED || counts.FAILED || counts.NO_DRIVER) {
        this.logger.log({ msg: 'Assignment retries', ...counts });
      }
    } catch (error) {
      this.logger.error({
        msg: 'Assignment retry tick failed; will try again',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
