/**
 * EtaProvider over an OSRM server (Project OSRM route service, ADR-020).
 *
 * Meant for local development and demos without an API key: the public demo
 * server (router.project-osrm.org) is free but only for reasonable,
 * non-commercial use, at most 1 request per second, without any guarantee.
 * A self-hosted OSRM (same API) removes those limits.
 *
 *   GET {base}/route/v1/{profile}/{lng},{lat};{lng},{lat}?overview=false&steps=false
 *   200 { "code": "Ok", "routes": [{ "duration": 426.6, "distance": 5553.6 }] }
 *   4xx { "code": "NoRoute" | "NoSegment" | "InvalidQuery" | ..., "message": "..." }
 */
import type { GeoLocation } from '@libs/events';
import { EtaProvider } from '../../../application/ports.js';
import { asSeconds, EtaProviderError, kindForStatus, requestJson } from './eta-provider-error.js';

export const OSRM_DEFAULT_BASE_URL = 'https://router.project-osrm.org';
export const OSRM_DEFAULT_PROFILE = 'driving';

const PROVIDER = 'osrm';

/** OSRM codes meaning "no route between these points". */
const NO_ROUTE_CODES = new Set(['NoRoute', 'NoSegment', 'NoMatch']);

export interface OsrmOptions {
  baseUrl?: string;
  profile?: string;
  timeoutMs: number;
}

export class OsrmEtaProvider extends EtaProvider {
  readonly enabled = true;
  private readonly base: string;
  private readonly profile: string;

  constructor(private readonly options: OsrmOptions) {
    super();
    this.base = (options.baseUrl || OSRM_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.profile = encodeURIComponent(options.profile || OSRM_DEFAULT_PROFILE);
  }

  async estimateSeconds(from: GeoLocation, to: GeoLocation): Promise<number> {
    const url = new URL(`${this.base}/route/v1/${this.profile}/${from.lng},${from.lat};${to.lng},${to.lat}`);
    url.searchParams.set('overview', 'false');
    url.searchParams.set('steps', 'false');

    const response = await requestJson(PROVIDER, url, { headers: { Accept: 'application/json' } }, this.options.timeoutMs);
    const body = response.body as { code?: unknown; message?: unknown; routes?: Array<{ duration?: unknown }> } | undefined;
    const code = typeof body?.code === 'string' ? body.code : undefined;

    if (code && NO_ROUTE_CODES.has(code)) {
      throw new EtaProviderError('NO_ROUTE', PROVIDER, `${code} ${typeof body?.message === 'string' ? body.message : ''}`.trim(), response.status);
    }
    if (!response.ok) {
      throw new EtaProviderError(kindForStatus(response.status), PROVIDER, code ?? `HTTP ${response.status}`, response.status);
    }
    if (code !== 'Ok') throw new EtaProviderError('INVALID_RESPONSE', PROVIDER, `unexpected code ${code ?? '(none)'}`);

    const seconds = asSeconds(Array.isArray(body?.routes) ? body.routes[0]?.duration : undefined);
    if (seconds === undefined) throw new EtaProviderError('INVALID_RESPONSE', PROVIDER, 'routes[0].duration is not a number');
    return seconds;
  }
}
