import { selectChannels } from './channel-selection.js';
import { DEFAULT_PREFERENCES } from './notification.js';

const reachable = { hasEmail: true, hasDevice: true };

describe('selectChannels', () => {
  it('uses push and email by default', () => {
    expect(selectChannels(DEFAULT_PREFERENCES, reachable)).toEqual(['PUSH', 'EMAIL']);
  });

  it('never sends email when the customer disabled it (F5-S5)', () => {
    expect(selectChannels({ ...DEFAULT_PREFERENCES, email: false }, reachable)).toEqual(['PUSH']);
  });

  it('skips push when the customer disabled it', () => {
    expect(selectChannels({ ...DEFAULT_PREFERENCES, push: false }, reachable)).toEqual(['EMAIL']);
  });

  it('skips channels where the customer cannot be reached', () => {
    expect(selectChannels(DEFAULT_PREFERENCES, { hasEmail: false, hasDevice: false })).toEqual([]);
  });
});
