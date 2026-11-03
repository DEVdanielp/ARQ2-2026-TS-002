import { DEFAULT_TERMINAL_VIEW_TTL_SECONDS, validateEnvironment } from './environment.js';

const VALID = {
  DATABASE_URL: 'postgres://query_archive_db:fasttrack@postgres:5432/query_archive_db',
  REDIS_URL: 'redis://redis:6379/0',
};

describe('validateEnvironment', () => {
  it('accepts the docker-compose values and defaults the TTL to 24 h', () => {
    const environment = validateEnvironment(VALID);
    expect(environment.TERMINAL_VIEW_TTL_SECONDS).toBe(DEFAULT_TERMINAL_VIEW_TTL_SECONDS);
  });

  it('converts the TTL from string', () => {
    expect(validateEnvironment({ ...VALID, TERMINAL_VIEW_TTL_SECONDS: '60' }).TERMINAL_VIEW_TTL_SECONDS).toBe(60);
  });

  it('lists every invalid variable', () => {
    expect(() => validateEnvironment({ REDIS_URL: 'http://redis', TERMINAL_VIEW_TTL_SECONDS: '0' })).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*TERMINAL_VIEW_TTL_SECONDS/,
    );
  });
});
