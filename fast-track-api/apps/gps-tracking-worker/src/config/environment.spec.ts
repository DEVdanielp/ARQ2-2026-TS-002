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
});
