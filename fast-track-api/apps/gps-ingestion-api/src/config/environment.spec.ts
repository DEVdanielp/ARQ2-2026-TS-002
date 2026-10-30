import { validateEnvironment } from './environment.js';

describe('validateEnvironment', () => {
  it('needs no variable (stateless service)', () => {
    expect(validateEnvironment({}).GPS_PUBLISH_TIMEOUT_MS).toBeUndefined();
  });

  it('converts the publish timeout to a number', () => {
    expect(validateEnvironment({ GPS_PUBLISH_TIMEOUT_MS: '2500' }).GPS_PUBLISH_TIMEOUT_MS).toBe(2500);
  });

  it('rejects an invalid timeout', () => {
    expect(() => validateEnvironment({ GPS_PUBLISH_TIMEOUT_MS: 'soon' })).toThrow(/GPS_PUBLISH_TIMEOUT_MS/);
    expect(() => validateEnvironment({ GPS_PUBLISH_TIMEOUT_MS: '10' })).toThrow(/GPS_PUBLISH_TIMEOUT_MS/);
  });
});
