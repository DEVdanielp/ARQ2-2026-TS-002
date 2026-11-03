import { EtaProviderError } from './eta-provider-error.js';
import { OpenRouteServiceEtaProvider } from './openrouteservice-eta-provider.js';

const FROM = { lat: 6.2442, lng: -75.5812 };
const TO = { lat: 6.2088, lng: -75.5679 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const provider = (overrides = {}) =>
  new OpenRouteServiceEtaProvider({ apiKey: 'test-key', timeoutMs: 2000, ...overrides });

describe('OpenRouteServiceEtaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs [lng, lat] coordinates with the key in the Authorization header and returns the duration', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { routes: [{ summary: { distance: 5553.6, duration: 426.6 } }] }));
    vi.stubGlobal('fetch', fetch);

    await expect(provider().estimateSeconds(FROM, TO)).resolves.toBe(426.6);

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.heigit.org/openrouteservice/v2/directions/driving-car');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('test-key');
    expect(String(url)).not.toContain('test-key');
    expect(JSON.parse(init.body)).toEqual({
      coordinates: [
        [-75.5812, 6.2442],
        [-75.5679, 6.2088],
      ],
      instructions: false,
      geometry: false,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the configured base URL (self-hosted) and profile', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { routes: [{ summary: { duration: 10 } }] }));
    vi.stubGlobal('fetch', fetch);

    await provider({ baseUrl: 'http://ors.local:8080/ors/', profile: 'driving-hgv' }).estimateSeconds(FROM, TO);

    expect(String(fetch.mock.calls[0][0])).toBe('http://ors.local:8080/ors/v2/directions/driving-hgv');
  });

  it('returns 0 when the summary has no duration (origin = destination)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { routes: [{ summary: {} }] })));
    await expect(provider().estimateSeconds(TO, TO)).resolves.toBe(0);
  });

  it.each([
    [401, { error: 'Access to this API has been disallowed' }, 'AUTH'],
    [403, { error: 'Forbidden' }, 'AUTH'],
    [429, { error: 'Rate limit exceeded' }, 'QUOTA'],
    [404, { error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' } }, 'NO_ROUTE'],
    [404, { error: { code: 2009, message: 'Route could not be found' } }, 'NO_ROUTE'],
    [500, { error: { code: 2099, message: 'Unknown internal error' } }, 'UNAVAILABLE'],
    [502, 'not json', 'UNAVAILABLE'],
  ])('HTTP %i -> %s', async (status, body, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));

    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ name: 'EtaProviderError', kind, status });
  });

  it.each([
    [{ routes: [] }],
    [{ routes: [{ summary: { duration: 'soon' } }] }],
    [{}],
  ])('a 200 without a usable summary is INVALID_RESPONSE (%o)', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, body)));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it('a timeout or a connection failure becomes TIMEOUT / NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'TIMEOUT' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toBeInstanceOf(EtaProviderError);
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'NETWORK' });
  });

  it('refuses to be built without a key', () => {
    expect(() => new OpenRouteServiceEtaProvider({ apiKey: '', timeoutMs: 2000 })).toThrow(/ORS_API_KEY/);
  });
});
