import { validateEnvironment } from './environment.js';

describe('validateEnvironment', () => {
  it('accepts a complete environment', () => {
    const url = 'postgres://orders_db:fasttrack@postgres:5432/orders_db';
    expect(validateEnvironment({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('stops the service when DATABASE_URL is missing', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL/);
  });
});
