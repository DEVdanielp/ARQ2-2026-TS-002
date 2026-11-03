import { EtaProvider } from '../../../application/ports.js';
import { EtaProviderError } from './eta-provider-error.js';
import { ResilientEtaProvider, type EtaBudget } from './resilient-eta-provider.js';

const A = { lat: 6.2442, lng: -75.5812 };
const B = { lat: 6.2088, lng: -75.5679 };

class ScriptedProvider extends EtaProvider {
  readonly enabled = true;
  calls = 0;
  failure: EtaProviderError | null = null;

  async estimateSeconds(): Promise<number> {
    this.calls++;
    if (this.failure) throw this.failure;
    return 120;
  }
}

function setup(budget: Partial<EtaBudget> = {}) {
  let now = Date.UTC(2026, 10, 2, 12, 0, 0);
  const inner = new ScriptedProvider();
  const guarded = new ResilientEtaProvider(
    inner,
    'openrouteservice',
    { perMinute: 3, perDay: 5, authCooldownMs: 600_000, quotaCooldownMs: 60_000, ...budget },
    () => now,
  );
  return { inner, guarded, advance: (ms: number) => (now += ms) };
}

describe('ResilientEtaProvider', () => {
  it('passes calls through while within the budget', async () => {
    const t = setup();
    await expect(t.guarded.estimateSeconds(A, B)).resolves.toBe(120);
    expect(t.inner.calls).toBe(1);
  });

  it('refuses without calling the provider above the per-minute limit, and recovers after a minute', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.guarded.estimateSeconds(A, B);

    await expect(t.guarded.estimateSeconds(A, B)).rejects.toMatchObject({ kind: 'QUOTA' });
    expect(t.inner.calls).toBe(3);

    t.advance(60_001);
    await expect(t.guarded.estimateSeconds(A, B)).resolves.toBe(120);
  });

  it('enforces the 24 h budget, then frees it after 24 h', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      await t.guarded.estimateSeconds(A, B);
      t.advance(61_000);
    }

    await expect(t.guarded.estimateSeconds(A, B)).rejects.toThrow(/per 24 h/);
    t.advance(24 * 3_600_000);
    await expect(t.guarded.estimateSeconds(A, B)).resolves.toBe(120);
  });

  it('pauses the provider after an AUTH error (bad key) for the auth cool-down', async () => {
    const t = setup();
    t.inner.failure = new EtaProviderError('AUTH', 'openrouteservice', 'disallowed', 403);
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toMatchObject({ kind: 'AUTH' });

    t.inner.failure = null;
    t.advance(599_000);
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toThrow(/paused/);
    expect(t.inner.calls).toBe(1);

    t.advance(2_000);
    await expect(t.guarded.estimateSeconds(A, B)).resolves.toBe(120);
  });

  it('pauses for the quota cool-down after a 429, but not after a NO_ROUTE or a timeout', async () => {
    const t = setup({ perMinute: 0, perDay: 0 });
    t.inner.failure = new EtaProviderError('NO_ROUTE', 'openrouteservice', '2010');
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toMatchObject({ kind: 'NO_ROUTE' });
    t.inner.failure = new EtaProviderError('TIMEOUT', 'openrouteservice', 'slow');
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toMatchObject({ kind: 'TIMEOUT' });
    t.inner.failure = new EtaProviderError('QUOTA', 'openrouteservice', '429', 429);
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toMatchObject({ kind: 'QUOTA' });

    t.inner.failure = null;
    await expect(t.guarded.estimateSeconds(A, B)).rejects.toThrow(/paused/);
    t.advance(60_001);
    await expect(t.guarded.estimateSeconds(A, B)).resolves.toBe(120);
    expect(t.inner.calls).toBe(4);
  });

  it('0 means no local limit', async () => {
    const t = setup({ perMinute: 0, perDay: 0 });
    for (let i = 0; i < 50; i++) await t.guarded.estimateSeconds(A, B);
    expect(t.inner.calls).toBe(50);
  });
});
