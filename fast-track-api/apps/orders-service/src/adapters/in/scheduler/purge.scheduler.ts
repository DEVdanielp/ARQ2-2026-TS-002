/**
 * Runs the cleanup of orders-db once an hour (ADR-009: "expire ids after the
 * retention window"; spec 2: keys last 24 h). A failed run only logs: the next
 * one catches up, and nothing depends on the rows being gone.
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PurgeExpired } from '../../../application/state-engine.use-cases.js';

const INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class PurgeScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PurgeScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly purgeExpired: PurgeExpired) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async run(): Promise<void> {
    try {
      await this.purgeExpired.execute();
    } catch (error) {
      this.logger.warn({
        msg: 'Cleanup failed; retrying next hour',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
