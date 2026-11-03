/**
 * Keeps the worker inside the provider's FREE quota (ADR-020) and stops it
 * from hammering a provider that already said no.
 *
 * ADR-013 already limits calls (only within 3 km, at most once per minute per
 * order). This decorator adds the provider's own limits on top:
 *
 * - Quota guard: at most `perMinute` calls in any 60 s window and `perDay` in
 *   any 24 h window (openrouteservice Standard: 40 / 2000). Over the limit the
 *   call is NOT made; it fails at once with kind QUOTA.
 * - Cool-down: after AUTH (bad key) the provider is skipped for
 *   `authCooldownMs`; after QUOTA (429) for `quotaCooldownMs`.
 *
 * Every refusal is an EtaProviderError, so ProcessGpsBatch falls back to
 * distance exactly as for any other provider failure. The counters are per
 * process: with several worker instances, split the budget among them.
 */
import { Logger } from '@nestjs/common';
import type { GeoLocation } from '@libs/events';
import { EtaProvider } from '../../../application/ports.js';
import { EtaProviderError } from './eta-provider-error.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface EtaBudget {
  /** Calls allowed in any 60 s window; 0 = no limit. */
  perMinute: number;
  /** Calls allowed in any 24 h window; 0 = no limit. */
  perDay: number;
  authCooldownMs: number;
  quotaCooldownMs: number;
}

export class ResilientEtaProvider extends EtaProvider {
  readonly enabled = true;
  private readonly logger = new Logger(ResilientEtaProvider.name);
  /** Start times of the calls of the last 24 h, oldest first. */
  private readonly calls: number[] = [];
  private pausedUntil = 0;

  constructor(
    private readonly inner: EtaProvider,
    private readonly name: string,
    private readonly budget: EtaBudget,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async estimateSeconds(from: GeoLocation, to: GeoLocation): Promise<number> {
    const now = this.now();
    if (now < this.pausedUntil) {
      throw new EtaProviderError('QUOTA', this.name, `paused for ${Math.ceil((this.pausedUntil - now) / 1000)} s after a refusal`);
    }

    while (this.calls.length > 0 && this.calls[0] <= now - DAY_MS) this.calls.shift();
    const inLastMinute = this.calls.filter((t) => t > now - MINUTE_MS).length;
    if (this.budget.perMinute > 0 && inLastMinute >= this.budget.perMinute) {
      throw new EtaProviderError('QUOTA', this.name, `local limit of ${this.budget.perMinute} calls per minute reached`);
    }
    if (this.budget.perDay > 0 && this.calls.length >= this.budget.perDay) {
      throw new EtaProviderError('QUOTA', this.name, `local limit of ${this.budget.perDay} calls per 24 h reached`);
    }

    this.calls.push(now);
    try {
      return await this.inner.estimateSeconds(from, to);
    } catch (error) {
      if (error instanceof EtaProviderError && (error.kind === 'AUTH' || error.kind === 'QUOTA')) {
        const pause = error.kind === 'AUTH' ? this.budget.authCooldownMs : this.budget.quotaCooldownMs;
        this.pausedUntil = this.now() + pause;
        this.logger.error({
          msg: `ETA provider refused the call; pausing it for ${Math.round(pause / 1000)} s`,
          provider: this.name,
          kind: error.kind,
          status: error.status,
          hint: error.kind === 'AUTH' ? 'check ORS_API_KEY' : 'free quota used up; NEARBY uses distance meanwhile',
        });
      }
      throw error;
    }
  }
}
