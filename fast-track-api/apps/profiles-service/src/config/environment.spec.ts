import { validateEnvironment } from './environment.js';

const valid = {
  DATABASE_URL: 'postgres://profiles_db:fasttrack@postgres:5432/profiles_db',
};

describe('validateEnvironment', () => {
  it('accepts the docker-compose values; optional settings fall back to the defaults', () => {
    const environment = validateEnvironment({
      ...valid,
      ASSIGNMENT_RETRY_SECONDS: '',
    });

    expect(environment.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(environment.ASSIGNMENT_RETRY_SECONDS).toBeUndefined();
  });

  it('converts the numeric settings', () => {
    const environment = validateEnvironment({
      ...valid,
      ASSIGNMENT_RETRY_SECONDS: '5',
      ASSIGNMENT_WINDOW_SECONDS: '60',
      DEFAULT_DRIVER_CAPACITY: '4',
    });

    expect(environment).toMatchObject({
      ASSIGNMENT_RETRY_SECONDS: 5,
      ASSIGNMENT_WINDOW_SECONDS: 60,
      DEFAULT_DRIVER_CAPACITY: 4,
    });
  });

  it('lists every missing or invalid variable', () => {
    expect(() =>
      validateEnvironment({
        ASSIGNMENT_RETRY_SECONDS: 'abc',
        DEFAULT_DRIVER_CAPACITY: '11',
      }),
    ).toThrow(
      /DATABASE_URL[\s\S]*ASSIGNMENT_RETRY_SECONDS[\s\S]*DEFAULT_DRIVER_CAPACITY/,
    );
  });
});
