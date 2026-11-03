/**
 * EtaProvider over openrouteservice (HeiGIT), the Maps/ETA provider chosen in
 * ADR-020: free "Standard" plan, API key without payment, OpenStreetMap data.
 *
 *   POST {base}/v2/directions/{profile}
 *   Authorization: <ORS_API_KEY>
 *   { "coordinates": [[lng, lat], [lng, lat]], "instructions": false, "geometry": false }
 *
 *   200 { "routes": [{ "summary": { "distance": 5553.6, "duration": 426.6 } }] }   (metres, seconds)
 *   4xx/5xx { "error": { "code": 2010, "message": "Could not find routable point..." } }
 *
 * The key goes in a header, never in the URL, so it does not end up in logs.
 * Coordinates are [longitude, latitude] (GeoJSON order).
 */
import type { GeoLocation } from '@libs/events';
import { EtaProvider } from '../../../application/ports.js';
import { asSeconds, EtaProviderError, kindForStatus, requestJson } from './eta-provider-error.js';

/** Host in use since 2026 (api.openrouteservice.org is deprecated, ADR-020). */
export const ORS_DEFAULT_BASE_URL = 'https://api.heigit.org/openrouteservice';
export const ORS_DEFAULT_PROFILE = 'driving-car';

const PROVIDER = 'openrouteservice';

/**
 * openrouteservice error codes meaning "no route between these points"
 * (2004 route too long, 2009 route not found, 2010 point not routable).
 */
const NO_ROUTE_CODES = new Set([2004, 2009, 2010]);

export interface OpenRouteServiceOptions {
  apiKey: string;
  baseUrl?: string;
  /** driving-car, driving-hgv, cycling-regular, ... */
  profile?: string;
  timeoutMs: number;
}

export class OpenRouteServiceEtaProvider extends EtaProvider {
  readonly enabled = true;
  private readonly url: URL;

  constructor(private readonly options: OpenRouteServiceOptions) {
    super();
    if (!options.apiKey) throw new Error('openrouteservice needs an API key (ORS_API_KEY)');
    const base = (options.baseUrl || ORS_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.url = new URL(`${base}/v2/directions/${encodeURIComponent(options.profile || ORS_DEFAULT_PROFILE)}`);
  }

  async estimateSeconds(from: GeoLocation, to: GeoLocation): Promise<number> {
    const response = await requestJson(
      PROVIDER,
      this.url,
      {
        method: 'POST',
        headers: {
          Authorization: this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          coordinates: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
          // Only the summary is needed: skip turn-by-turn and the polyline.
          instructions: false,
          geometry: false,
        }),
      },
      this.options.timeoutMs,
    );

    if (!response.ok) throw this.errorFrom(response.status, response.body);

    const routes = (response.body as { routes?: Array<{ summary?: { duration?: unknown } }> } | undefined)?.routes;
    const summary = Array.isArray(routes) ? routes[0]?.summary : undefined;
    if (!summary || typeof summary !== 'object') {
      throw new EtaProviderError('INVALID_RESPONSE', PROVIDER, 'response has no routes[0].summary');
    }
    // openrouteservice omits `duration` when it is 0 (origin = destination).
    if (summary.duration === undefined) return 0;
    const seconds = asSeconds(summary.duration);
    if (seconds === undefined) throw new EtaProviderError('INVALID_RESPONSE', PROVIDER, 'routes[0].summary.duration is not a number');
    return seconds;
  }

  private errorFrom(status: number, body: unknown): EtaProviderError {
    const error = (body as { error?: unknown } | undefined)?.error;
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    const message =
      typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : `HTTP ${status}`;

    if (typeof code === 'number' && NO_ROUTE_CODES.has(code)) {
      return new EtaProviderError('NO_ROUTE', PROVIDER, `${code} ${message}`, status);
    }
    return new EtaProviderError(kindForStatus(status), PROVIDER, message, status);
  }
}
