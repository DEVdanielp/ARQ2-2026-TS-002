import { OsrmEtaProvider } from './osrm-eta-provider.js';

const FROM = { lat: 6.2442, lng: -75.5812 };
const TO = { lat: 6.2088, lng: -75.5679 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const provider = (overrides = {}) => new OsrmEtaProvider({ timeoutMs: 2000, ...overrides });

describe('OsrmEtaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs the route lng,lat;lng,lat without geometry and returns the duration', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { code: 'Ok', routes: [{ duration: 426.6, distance: 5553.6 }] }));
    vi.stubGlobal('fetch', fetch);

    await expect(provider().estimateSeconds(FROM, TO)).resolves.toBe(426.6);

    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://router.project-osrm.org/route/v1/driving/-75.5812,6.2442;-75.5679,6.2088?overview=false&steps=false',
    );
  });

  it('uses a self-hosted base URL and profile', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { code: 'Ok', routes: [{ duration: 1 }] }));
    vi.stubGlobal('fetch', fetch);

    await provider({ baseUrl: 'http://osrm:5000/', profile: 'car' }).estimateSeconds(FROM, TO);

    expect(String(fetch.mock.calls[0][0])).toMatch(/^http:\/\/osrm:5000\/route\/v1\/car\//);
  });

  it.each([
    [400, { code: 'NoRoute', message: 'Impossible route between points' }, 'NO_ROUTE'],
    [400, { code: 'NoSegment', message: 'Could not find a matching segment' }, 'NO_ROUTE'],
    [400, { code: 'InvalidQuery' }, 'UNAVAILABLE'],
    [429, { code: 'TooBig' }, 'QUOTA'],
    [503, 'busy', 'UNAVAILABLE'],
  ])('HTTP %i %o -> %s', async (status, body, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind });
  });

  it('a 200 that is not "Ok" or has no duration is INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { code: 'Weird' })));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { code: 'Ok', routes: [] })));
    await expect(provider().estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
});
