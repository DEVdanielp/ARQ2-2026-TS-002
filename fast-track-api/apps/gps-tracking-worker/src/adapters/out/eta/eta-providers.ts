/**
 * EtaProvider adapters (ADR-013) and the factory that picks one (ADR-020).
 *
 * - DistanceOnlyEtaProvider (`none`): the provider is never called and NEARBY
 *   uses distance only.
 * - OpenRouteServiceEtaProvider (`openrouteservice`): the selected free
 *   Maps/ETA provider (ADR-020). Needs ORS_API_KEY.
 * - OsrmEtaProvider (`osrm`): keyless OSRM, for local development and demos.
 * - HttpEtaProvider (`http`): the generic contract of ADR-018, for a proxy in
 *   front of any routing product:
 *
 *   GET {ETA_PROVIDER_URL}?originLat=..&originLng=..&destinationLat=..&destinationLng=..
 *   200 { "etaSeconds": 260 }
 *
 * Every real provider is wrapped in ResilientEtaProvider (quota guard and
 * cool-down). All of them throw on failure, and ProcessGpsBatch then falls
 * back to distance: the GPS path never depends on the provider.
 */
import { Logger } from '@nestjs/common';
import type { GeoLocation } from '@libs/events';
import { EtaProvider } from '../../../application/ports.js';
import { OpenRouteServiceEtaProvider } from './openrouteservice-eta-provider.js';
import { OsrmEtaProvider } from './osrm-eta-provider.js';
import { ResilientEtaProvider, type EtaBudget } from './resilient-eta-provider.js';

export class DistanceOnlyEtaProvider extends EtaProvider {
  readonly enabled = false;

  async estimateSeconds(): Promise<number> {
    throw new Error('No ETA provider configured (ETA_PROVIDER_URL is empty)');
  }
}

export class HttpEtaProvider extends EtaProvider {
  readonly enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async estimateSeconds(from: GeoLocation, to: GeoLocation): Promise<number> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('originLat', String(from.lat));
    url.searchParams.set('originLng', String(from.lng));
    url.searchParams.set('destinationLat', String(to.lat));
    url.searchParams.set('destinationLng', String(to.lng));

    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`ETA provider answered ${response.status}`);
    const body = (await response.json()) as { etaSeconds?: unknown };
    if (typeof body.etaSeconds !== 'number' || !Number.isFinite(body.etaSeconds) || body.etaSeconds < 0) {
      throw new Error('ETA provider response has no valid "etaSeconds"');
    }
    return body.etaSeconds;
  }
}

export const EtaProviderNames = ['none', 'http', 'openrouteservice', 'osrm'] as const;
export type EtaProviderName = (typeof EtaProviderNames)[number];

/** What the factory needs, read from the environment (config/environment.ts). */
export interface EtaProviderConfig {
  /** ETA_PROVIDER; undefined = choose from the other variables. */
  provider?: EtaProviderName;
  /** ETA_PROVIDER_URL: the `http` endpoint, or a base URL override for openrouteservice/osrm. */
  url?: string;
  /** ORS_API_KEY (secret: only from the environment). */
  orsApiKey?: string;
  /** ETA_ROUTING_PROFILE; default driving-car (openrouteservice) / driving (osrm). */
  profile?: string;
  timeoutMs: number;
  /** ETA_RATE_LIMIT_PER_MINUTE / ETA_DAILY_QUOTA; undefined = the provider's free limits. */
  perMinute?: number;
  perDay?: number;
}

/**
 * Free limits per provider (ADR-020): openrouteservice Standard plan 40/min
 * and 2000/day for directions; OSRM demo server 1 request per second.
 */
const DEFAULT_BUDGETS: Record<Exclude<EtaProviderName, 'none'>, { perMinute: number; perDay: number }> = {
  openrouteservice: { perMinute: 40, perDay: 2_000 },
  osrm: { perMinute: 60, perDay: 0 },
  http: { perMinute: 0, perDay: 0 },
};

const AUTH_COOLDOWN_MS = 10 * 60_000;
const QUOTA_COOLDOWN_MS = 60_000;

/**
 * Without ETA_PROVIDER the previous behaviour is kept (ADR-018): a URL means
 * the generic `http` contract, nothing means distance only. An ORS_API_KEY
 * alone selects openrouteservice.
 */
export function resolveEtaProviderName(config: Pick<EtaProviderConfig, 'provider' | 'url' | 'orsApiKey'>): EtaProviderName {
  if (config.provider) return config.provider;
  if (config.orsApiKey) return 'openrouteservice';
  return config.url ? 'http' : 'none';
}

export function createEtaProvider(config: EtaProviderConfig): EtaProvider {
  const logger = new Logger('EtaProvider');
  const name = resolveEtaProviderName(config);
  if (name === 'none') {
    logger.log('No ETA provider configured: NEARBY uses distance only (ADR-013)');
    return new DistanceOnlyEtaProvider();
  }

  let provider: EtaProvider;
  if (name === 'openrouteservice') {
    if (!config.orsApiKey) throw new Error('ETA_PROVIDER=openrouteservice needs ORS_API_KEY');
    provider = new OpenRouteServiceEtaProvider({
      apiKey: config.orsApiKey,
      baseUrl: config.url,
      profile: config.profile,
      timeoutMs: config.timeoutMs,
    });
  } else if (name === 'osrm') {
    provider = new OsrmEtaProvider({ baseUrl: config.url, profile: config.profile, timeoutMs: config.timeoutMs });
  } else {
    if (!config.url) throw new Error('ETA_PROVIDER=http needs ETA_PROVIDER_URL');
    provider = new HttpEtaProvider(config.url, config.timeoutMs);
  }

  const budget: EtaBudget = {
    perMinute: config.perMinute ?? DEFAULT_BUDGETS[name].perMinute,
    perDay: config.perDay ?? DEFAULT_BUDGETS[name].perDay,
    authCooldownMs: AUTH_COOLDOWN_MS,
    quotaCooldownMs: QUOTA_COOLDOWN_MS,
  };
  // Never log the key; only the provider and its limits.
  logger.log(
    `ETA provider: ${name} (limits: ${budget.perMinute || 'no'} per minute, ${budget.perDay || 'no'} per day; ` +
      `timeout ${config.timeoutMs} ms; distance fallback on any failure)`,
  );
  return new ResilientEtaProvider(provider, name, budget);
}
