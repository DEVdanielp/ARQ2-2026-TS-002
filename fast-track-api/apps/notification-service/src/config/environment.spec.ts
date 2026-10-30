import { validateEnvironment } from './environment.js';

const valid = {
  DATABASE_URL: 'postgres://notifications_db:fasttrack@postgres:5432/notifications_db',
  SMTP_HOST: 'mailhog',
  SMTP_PORT: '1025',
  SMTP_FROM: 'no-reply@fasttrack.local',
  FCM_CREDENTIALS_FILE: '',
  OPS_ALERT_EMAIL: 'ops@fasttrack.local',
};

describe('validateEnvironment', () => {
  it('accepts the docker-compose values and converts the port to a number', () => {
    const environment = validateEnvironment(valid);

    expect(environment.SMTP_PORT).toBe(1025);
    expect(environment.FCM_CREDENTIALS_FILE).toBe('');
  });

  it('lists every missing or invalid variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = valid;

    expect(() => validateEnvironment({ ...withoutDatabase, SMTP_PORT: 'abc', OPS_ALERT_EMAIL: 'nope' })).toThrow(
      /DATABASE_URL[\s\S]*SMTP_PORT[\s\S]*OPS_ALERT_EMAIL/,
    );
  });
});
