import { createEtaProvider, DistanceOnlyEtaProvider, HttpEtaProvider, resolveEtaProviderName } from './eta-providers.js';
import { ResilientEtaProvider } from './resilient-eta-provider.js';

const FROM = { lat: 6.2121, lng: -75.5701 };
const TO = { lat: 6.2088, lng: -75.5679 };

describe('resolveEtaProviderName', () => {
  it('keeps the previous behaviour without ETA_PROVIDER (ADR-018): URL -> http, nothing -> none', () => {
    expect(resolveEtaProviderName({})).toBe('none');
    expect(resolveEtaProviderName({ url: 'http://eta.local/eta' })).toBe('http');
  });

  it('an ORS_API_KEY alone selects openrouteservice; ETA_PROVIDER always wins', () => {
    expect(resolveEtaProviderName({ orsApiKey: 'k' })).toBe('openrouteservice');
    expect(resolveEtaProviderName({ provider: 'osrm', orsApiKey: 'k' })).toBe('osrm');
    expect(resolveEtaProviderName({ provider: 'none', orsApiKey: 'k' })).toBe('none');
  });
});

describe('createEtaProvider', () => {
  it('uses distance only when nothing is configured', () => {
    expect(createEtaProvider({ timeoutMs: 2000 })).toBeInstanceOf(DistanceOnlyEtaProvider);
    expect(createEtaProvider({ timeoutMs: 2000 }).enabled).toBe(false);
  });

  it.each([
    [{ url: 'http://eta.local/eta' }],
    [{ provider: 'openrouteservice' as const, orsApiKey: 'k' }],
    [{ provider: 'osrm' as const }],
  ])('wraps every real provider in the quota guard (%o)', (config) => {
    const provider = createEtaProvider({ ...config, timeoutMs: 2000 });
    expect(provider).toBeInstanceOf(ResilientEtaProvider);
    expect(provider.enabled).toBe(true);
  });

  it('refuses openrouteservice without a key and http without a URL', () => {
    expect(() => createEtaProvider({ provider: 'openrouteservice', timeoutMs: 2000 })).toThrow(/ORS_API_KEY/);
    expect(() => createEtaProvider({ provider: 'http', timeoutMs: 2000 })).toThrow(/ETA_PROVIDER_URL/);
  });
});

describe('HttpEtaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the provider with origin and destination and returns etaSeconds', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ etaSeconds: 260 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(new HttpEtaProvider('http://eta.local/eta', 2000).estimateSeconds(FROM, TO)).resolves.toBe(260);

    const url = new URL(fetch.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      originLat: '6.2121',
      originLng: '-75.5701',
      destinationLat: '6.2088',
      destinationLng: '-75.5679',
    });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on an error status or an invalid body, so the worker falls back to distance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    await expect(new HttpEtaProvider('http://eta.local/eta', 2000).estimateSeconds(FROM, TO)).rejects.toThrow(/503/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ eta: 'soon' }), { status: 200 })));
    await expect(new HttpEtaProvider('http://eta.local/eta', 2000).estimateSeconds(FROM, TO)).rejects.toThrow(/etaSeconds/);
  });
});
