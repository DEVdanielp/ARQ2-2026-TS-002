/**
 * LIVE tests of the Maps/ETA providers (ADR-020): real HTTP calls over the
 * internet. Opt-in, so CI and offline runs never depend on a third party:
 *
 *   $env:ETA_LIVE = "1"                 # OSRM demo + openrouteservice error handling
 *   $env:ORS_API_KEY = "<your free key>" # + a real openrouteservice route
 *   npm run test:e2e
 *
 * They make at most 5 requests, well inside both free limits.
 */
import { createEtaProvider } from '../src/adapters/out/eta/eta-providers.js';
import { OpenRouteServiceEtaProvider } from '../src/adapters/out/eta/openrouteservice-eta-provider.js';
import { OsrmEtaProvider } from '../src/adapters/out/eta/osrm-eta-provider.js';
import { TrackingSettings } from '../src/application/ports.js';
import { ProcessGpsBatch } from '../src/application/process-gps-batch.js';
import { InMemoryDriverTrackingStore, InMemoryTrackingDb } from '../src/application/testing/in-memory.js';

const live = process.env.ETA_LIVE === '1';
const orsKey = process.env.ORS_API_KEY;

// Medellín: ~4 km by road from El Poblado park to a destination south of it (spec examples).
const FROM = { lat: 6.2442, lng: -75.5812 };
const TO = { lat: 6.2088, lng: -75.5679 };
// The middle of the Pacific Ocean: no road within reach.
const OCEAN = { lat: 0, lng: -140 };

describe.skipIf(!live)('OSRM demo server (live)', () => {
  const osrm = new OsrmEtaProvider({ timeoutMs: 10_000 });

  it('returns a plausible driving time for a ~4 km urban route', async () => {
    const seconds = await osrm.estimateSeconds(FROM, TO);
    expect(seconds).toBeGreaterThan(120);
    expect(seconds).toBeLessThan(3_600);
  });

  it('times out as TIMEOUT when the provider is slower than the limit', async () => {
    await expect(new OsrmEtaProvider({ timeoutMs: 1 }).estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
});

describe.skipIf(!live)('ProcessGpsBatch + live OSRM (NEARBY by ETA)', () => {
  it('a point ~1 km away (outside 500 m, inside 3 km) fires NEARBY with trigger ETA from the real provider', async () => {
    const db = new InMemoryTrackingDb();
    const orderId = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';
    const driverId = '22222222-2222-4222-8222-222222222221';
    db.addMonitoredOrder(orderId, driverId, TO);
    const processor = new ProcessGpsBatch(
      new InMemoryDriverTrackingStore(db),
      createEtaProvider({ provider: 'osrm', timeoutMs: 10_000 }),
      new TrackingSettings(500, 300, 3_000, 60),
    );

    const result = await processor.execute({
      payload: {
        driverId,
        batchId: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9',
        receivedAt: new Date().toISOString(),
        points: [{ lat: 6.2178, lng: -75.5679, deviceTime: new Date().toISOString(), sequence: 1 }],
      },
      correlationId: 'live-eta',
    });

    expect(result.nearby).toEqual([orderId]);
    const [event] = db.eventsOf('DriverNearDestination');
    expect(event.envelope.payload).toMatchObject({ trigger: 'ETA', distanceMeters: 1_001 });
    expect((event.envelope.payload as { etaSeconds: number }).etaSeconds).toBeLessThan(300);
    expect(db.orders.get(orderId)?.etaCheckedAt).toBeInstanceOf(Date);
  });
});

describe.skipIf(!live)('openrouteservice (live, error handling)', () => {
  it('reaches api.heigit.org and reports a rejected key as AUTH', async () => {
    const ors = new OpenRouteServiceEtaProvider({ apiKey: 'invalid-key-for-tests', timeoutMs: 10_000 });
    await expect(ors.estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'AUTH', provider: 'openrouteservice' });
  });

  it('an unreachable host is NETWORK', async () => {
    const ors = new OpenRouteServiceEtaProvider({ apiKey: 'x', baseUrl: 'http://127.0.0.1:9', timeoutMs: 3_000 });
    await expect(ors.estimateSeconds(FROM, TO)).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});

describe.skipIf(!live || !orsKey)('openrouteservice (live, with ORS_API_KEY)', () => {
  // Built lazily: the describe body runs even when the block is skipped.
  const ors = { estimateSeconds: (...args: Parameters<OsrmEtaProvider['estimateSeconds']>) =>
    createEtaProvider({ provider: 'openrouteservice', orsApiKey: orsKey, timeoutMs: 10_000 }).estimateSeconds(...args) };

  it('returns a plausible driving time for a ~4 km urban route', async () => {
    const seconds = await ors.estimateSeconds(FROM, TO);
    expect(seconds).toBeGreaterThan(120);
    expect(seconds).toBeLessThan(3_600);
  });

  it('reports a point far from any road as NO_ROUTE', async () => {
    await expect(ors.estimateSeconds(OCEAN, TO)).rejects.toMatchObject({ kind: 'NO_ROUTE' });
  });
});
