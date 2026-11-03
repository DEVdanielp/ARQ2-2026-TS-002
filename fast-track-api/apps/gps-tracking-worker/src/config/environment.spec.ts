import { validateEnvironment } from './environment.js';

const compose = {
  DATABASE_URL: 'postgres://tracking_db:fasttrack@postgres:5432/tracking_db',
  ETA_PROVIDER_URL: '',
  NEARBY_DISTANCE_METERS: '500',
  NEARBY_ETA_SECONDS: '300',
};

describe('validateEnvironment', () => {
  it('accepts the docker-compose values (empty ETA URL = distance only)', () => {
    const environment = validateEnvironment(compose);

    expect(environment.NEARBY_DISTANCE_METERS).toBe(500);
    expect(environment.ETA_PROVIDER_URL).toBe('');
    expect(environment.ETA_TIMEOUT_MS).toBeUndefined();
  });

  it('accepts an ETA provider URL', () => {
    expect(validateEnvironment({ ...compose, ETA_PROVIDER_URL: 'http://eta-proxy:8080/eta' }).ETA_PROVIDER_URL).toBe(
      'http://eta-proxy:8080/eta',
    );
  });

  it('lists every missing or invalid variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = compose;

    expect(() =>
      validateEnvironment({ ...withoutDatabase, NEARBY_DISTANCE_METERS: 'far', ETA_PROVIDER_URL: 'not a url' }),
    ).toThrow(/DATABASE_URL[\s\S]*NEARBY_DISTANCE_METERS[\s\S]*ETA_PROVIDER_URL/);
  });

  describe('Maps/ETA provider (ADR-020)', () => {
    it('accepts openrouteservice with its key and optional limits', () => {
      const environment = validateEnvironment({
        ...compose,
        ETA_PROVIDER: 'openrouteservice',
        ORS_API_KEY: 'a-free-key',
        ETA_ROUTING_PROFILE: 'driving-car',
        ETA_RATE_LIMIT_PER_MINUTE: '20',
        ETA_DAILY_QUOTA: '1000',
      });
      expect(environment).toMatchObject({ ETA_PROVIDER: 'openrouteservice', ETA_RATE_LIMIT_PER_MINUTE: 20, ETA_DAILY_QUOTA: 1000 });
    });

    it('requires ORS_API_KEY for openrouteservice and a URL for http', () => {
      expect(() => validateEnvironment({ ...compose, ETA_PROVIDER: 'openrouteservice' })).toThrow(/ORS_API_KEY/);
      expect(() => validateEnvironment({ ...compose, ETA_PROVIDER: 'http' })).toThrow(/ETA_PROVIDER_URL/);
    });

    it('accepts osrm without key or URL, and an empty ETA_PROVIDER (automatic)', () => {
      expect(() => validateEnvironment({ ...compose, ETA_PROVIDER: 'osrm' })).not.toThrow();
      expect(() => validateEnvironment({ ...compose, ETA_PROVIDER: '', ORS_API_KEY: '' })).not.toThrow();
    });

    it('rejects an unknown provider or profile', () => {
      expect(() => validateEnvironment({ ...compose, ETA_PROVIDER: 'google' })).toThrow(/ETA_PROVIDER/);
      expect(() => validateEnvironment({ ...compose, ETA_ROUTING_PROFILE: 'car; drop' })).toThrow(/ETA_ROUTING_PROFILE/);
    });
  });
});
