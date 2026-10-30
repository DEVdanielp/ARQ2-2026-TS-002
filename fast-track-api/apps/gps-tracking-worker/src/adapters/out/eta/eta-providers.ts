/**
 * EtaProvider adapters (ADR-013).
 *
 * - DistanceOnlyEtaProvider: `ETA_PROVIDER_URL` empty (the local default). The
 *   provider is never called and NEARBY uses distance only.
 * - HttpEtaProvider: calls the Maps/ETA provider with a short timeout.
 *
 * The spec names the Maps/ETA Provider as an external system but does not fix
 * its API. The contract assumed here (ADR-018) is deliberately minimal, so a
 * thin proxy can adapt any routing product to it:
 *
 *   GET {ETA_PROVIDER_URL}?originLat=..&originLng=..&destinationLat=..&destinationLng=..
 *   200 { "etaSeconds": 260 }
 */
import { Logger } from '@nestjs/common';
import type { GeoLocation } from '@libs/events';
import { EtaProvider } from '../../../application/ports.js';

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

/** Empty URL = distance-only mode. */
export function createEtaProvider(url: string | undefined, timeoutMs: number): EtaProvider {
  if (!url) {
    new Logger('EtaProvider').log('ETA_PROVIDER_URL is empty: NEARBY uses distance only (ADR-013)');
    return new DistanceOnlyEtaProvider();
  }
  return new HttpEtaProvider(url, timeoutMs);
}
