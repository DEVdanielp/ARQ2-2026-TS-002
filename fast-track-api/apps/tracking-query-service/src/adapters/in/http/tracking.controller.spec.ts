/**
 * HTTP adapter tests: real controller, guard and problem+json filter; fakes
 * instead of Redis and PostgreSQL. Tokens are unsigned JWTs: the service only
 * decodes them (Kong verifies).
 */
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';
import { TrackingCacheUnavailableError } from '../../../application/errors.js';
import { GetOrderRoute } from '../../../application/get-route.js';
import { GetTrackingView } from '../../../application/get-tracking-view.js';
import { Clock, TrackingArchive, TrackingQuerySettings, TrackingViewStore, ViewChangeBus } from '../../../application/ports.js';
import {
  FakeTrackingViewStore,
  FixedClock,
  InMemoryTrackingArchive,
  InMemoryViewChangeBus,
  storedView,
} from '../../../application/testing/in-memory.js';
import { WatchTrackingView } from '../../../application/watch-tracking-view.js';
import { TrackingController } from './tracking.controller.js';

const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';
const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';

function token(sub: string, role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub, realm_access: { roles: [role] } })}.x`;
}
const bearer = (sub: string, role: string) => `Bearer ${token(sub, role)}`;

describe('TrackingController', () => {
  let app: INestApplication;
  const views = new FakeTrackingViewStore();
  const archive = new InMemoryTrackingArchive();
  const bus = new InMemoryViewChangeBus();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        GetTrackingView,
        WatchTrackingView,
        GetOrderRoute,
        { provide: TrackingViewStore, useValue: views },
        { provide: TrackingArchive, useValue: archive },
        { provide: ViewChangeBus, useValue: bus },
        { provide: Clock, useValue: new FixedClock(new Date('2026-10-18T15:24:06Z')) },
        { provide: TrackingQuerySettings, useValue: new TrackingQuerySettings(86_400, 15) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
  });

  beforeEach(() => {
    views.views.clear();
    views.getError = null;
    archive.snapshots.clear();
    archive.points.length = 0;
  });

  afterAll(() => app.close());

  const server = () => app.getHttpServer();

  describe('GET /v1/tracking/:orderId', () => {
    it('returns the TrackingView to the owner', async () => {
      views.views.set(ORDER, storedView());
      const response = await request(server()).get(`/v1/tracking/${ORDER}`).set('Authorization', bearer(CUSTOMER, 'CUSTOMER'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ orderId: ORDER, status: 'ON_THE_WAY', locationAgeSeconds: 240, trackingAvailable: true });
      expect(response.body.customerId).toBeUndefined();
    });

    it('401 without token', async () => {
      const response = await request(server()).get(`/v1/tracking/${ORDER}`);
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('403 for a driver and for another customer', async () => {
      views.views.set(ORDER, storedView());
      expect((await request(server()).get(`/v1/tracking/${ORDER}`).set('Authorization', bearer(CUSTOMER, 'DRIVER'))).status).toBe(403);
      expect((await request(server()).get(`/v1/tracking/${ORDER}`).set('Authorization', bearer('someone', 'CUSTOMER'))).status).toBe(403);
    });

    it('404 for an unknown order; 400 for an id that is not a UUID', async () => {
      expect((await request(server()).get(`/v1/tracking/${ORDER}`).set('Authorization', bearer('ops', 'OPERATIONS'))).status).toBe(404);
      expect((await request(server()).get('/v1/tracking/abc').set('Authorization', bearer('ops', 'OPERATIONS'))).status).toBe(400);
    });

    it('503 when Redis is unavailable', async () => {
      views.getError = new TrackingCacheUnavailableError(new Error('ECONNREFUSED'));
      const response = await request(server()).get(`/v1/tracking/${ORDER}`).set('Authorization', bearer('ops', 'OPERATIONS'));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ status: 503, title: 'Tracking temporarily unavailable' });
    });
  });

  describe('GET /v1/tracking/:orderId/route', () => {
    it('is only for operations', async () => {
      const response = await request(server()).get(`/v1/tracking/${ORDER}/route`).set('Authorization', bearer(CUSTOMER, 'CUSTOMER'));
      expect(response.status).toBe(403);
    });

    it('returns the route; 400 for an invalid range', async () => {
      archive.points.push({ orderId: ORDER, driverId: 'd-1', location: { lat: 1, lng: 2 }, deviceTime: '2026-10-18T15:20:01Z', sequence: 1 });
      const ok = await request(server()).get(`/v1/tracking/${ORDER}/route`).set('Authorization', bearer('ops', 'OPERATIONS'));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ orderId: ORDER, driverId: 'd-1', points: [{ lat: 1, lng: 2, deviceTime: '2026-10-18T15:20:01Z', sequence: 1 }] });

      const bad = await request(server())
        .get(`/v1/tracking/${ORDER}/route?from=2026-10-18T16:00:00Z&to=2026-10-18T15:00:00Z`)
        .set('Authorization', bearer('ops', 'OPERATIONS'));
      expect(bad.status).toBe(400);
      expect(bad.body.type).toContain('invalid-range');
    });
  });

  describe('GET /v1/tracking/:orderId/stream (SSE)', () => {
    const streamUrl = (query = '') => `http://127.0.0.1:${(server().address() as AddressInfo).port}/v1/tracking/${ORDER}/stream${query}`;

    /** Reads the stream until `predicate` matches what was received, then aborts. */
    async function readStream(response: Response, predicate: (text: string) => boolean): Promise<string> {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!predicate(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      await reader.cancel();
      return text;
    }

    it('sends the current view, then each change, as `event: tracking` with id = revision', async () => {
      views.views.set(ORDER, storedView({ revision: 5 }));
      const controller = new AbortController();
      const response = await fetch(streamUrl(), {
        headers: { Authorization: bearer(CUSTOMER, 'CUSTOMER'), Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      setTimeout(() => {
        views.views.set(ORDER, storedView({ revision: 6, nearbyReached: true }));
        void bus.publish(ORDER);
      }, 50);
      const text = await readStream(response, (t) => t.includes('id: 6'));
      controller.abort();

      expect(text).toContain('id: 5\nevent: tracking\ndata: {"orderId":"6f1c2b7e-0000-4000-8000-000000000001"');
      expect(text).toMatch(/id: 6\nevent: tracking\ndata: .*"nearbyReached":true/);
    });

    it('accepts the token in ?jwt= (EventSource) and answers 403/404 before streaming', async () => {
      views.views.set(ORDER, storedView());
      const forbidden = await fetch(streamUrl(`?jwt=${token('someone', 'CUSTOMER')}`));
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get('content-type')).toContain('application/problem+json');

      views.views.clear();
      const missing = await fetch(streamUrl(`?jwt=${token('ops', 'OPERATIONS')}`));
      expect(missing.status).toBe(404);
    });
  });
});
