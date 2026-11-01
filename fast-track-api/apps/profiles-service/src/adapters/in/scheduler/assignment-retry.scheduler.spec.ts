import type { RetryDueAssignments } from '../../../application/assignment.use-cases.js';
import {
  AssignmentRetryScheduler,
  SchedulerSettings,
} from './assignment-retry.scheduler.js';

const counts = { ASSIGNED: 0, NO_DRIVER: 0, FAILED: 0, NOT_PENDING: 0 };

describe('AssignmentRetryScheduler', () => {
  it('never runs two ticks at the same time', async () => {
    let release!: () => void;
    const retry = {
      execute: vi.fn(
        () => new Promise((resolve) => (release = () => resolve(counts))),
      ),
    };
    const scheduler = new AssignmentRetryScheduler(
      retry as unknown as RetryDueAssignments,
      new SchedulerSettings(1000),
    );

    const first = scheduler.tick();
    await scheduler.tick(); // skipped: the first is still running
    release();
    await first;

    expect(retry.execute).toHaveBeenCalledTimes(1);
  });

  it('a failing tick is logged, not thrown, and the next tick runs', async () => {
    const retry = {
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValue(counts),
    };
    const scheduler = new AssignmentRetryScheduler(
      retry as unknown as RetryDueAssignments,
      new SchedulerSettings(1000),
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();
    expect(retry.execute).toHaveBeenCalledTimes(2);
  });

  it('starts a timer on bootstrap and stops it on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const retry = { execute: vi.fn().mockResolvedValue(counts) };
      const scheduler = new AssignmentRetryScheduler(
        retry as unknown as RetryDueAssignments,
        new SchedulerSettings(1000),
      );
      scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(3000);
      scheduler.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(3000);

      expect(retry.execute).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
