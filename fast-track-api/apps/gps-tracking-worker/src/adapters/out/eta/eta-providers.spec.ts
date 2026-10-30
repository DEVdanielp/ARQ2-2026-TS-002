import { createEtaProvider, DistanceOnlyEtaProvider, HttpEtaProvider } from './eta-providers.js';

const FROM = { lat: 6.2121, lng: -75.5701 };
const TO = { lat: 6.2088, lng: -75.5679 };

describe('createEtaProvider', () => {
  it('uses distance only when no URL is configured', () => {
    expect(createEtaProvider('', 2000)).toBeInstanceOf(DistanceOnlyEtaProvider);
    expect(createEtaProvider(undefined, 2000).enabled).toBe(false);
  });

  it('uses HTTP when a URL is configured', () => {
    expect(createEtaProvider('http://eta.local/eta', 2000)).toBeInstanceOf(HttpEtaProvider);
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
