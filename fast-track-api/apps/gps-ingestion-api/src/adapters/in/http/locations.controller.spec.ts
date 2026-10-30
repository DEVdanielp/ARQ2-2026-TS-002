/**
 * HTTP adapter tests: real controller, guard, body parser, validation pipe and
 * problem+json filter (configureHttp, as in main.ts); a fake publisher instead
 * of Kafka. Tokens are unsigned JWTs: the service only decodes them (Kong verifies).
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { EventEnvelope, GpsBatchReceivedPayload } from '@libs/events';
import { IngestGpsBatch } from '../../../application/ingest-gps-batch.js';
import { EventBusUnavailableError, GpsBatchPublisher } from '../../../application/ports.js';
import { configureHttp } from '../../../http-setup.js';
import { LocationsController } from './locations.controller.js';

const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const PATH = '/v1/drivers/me/locations';

function token(sub: string, role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${encode({ alg: 'none' })}.${encode({ sub, realm_access: { roles: [role] } })}.x`;
}

function point(sequence: number, overrides: object = {}) {
  return { lat: 6.2442, lng: -75.5812, deviceTime: '2026-10-18T15:20:01Z', sequence, ...overrides };
}

class FakePublisher extends GpsBatchPublisher {
  published: EventEnvelope<GpsBatchReceivedPayload>[] = [];
  failure: Error | null = null;

  async publish(envelope: EventEnvelope<GpsBatchReceivedPayload>): Promise<void> {
    if (this.failure) throw this.failure;
    this.published.push(envelope);
  }
}

describe('LocationsController', () => {
  let app: NestExpressApplication;
  const publisher = new FakePublisher();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [IngestGpsBatch, { provide: GpsBatchPublisher, useValue: publisher }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureHttp(app);
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    publisher.published = [];
    publisher.failure = null;
  });

  const server = () => app.getHttpServer();
  const send = (body: unknown, auth = token(DRIVER, 'DRIVER')) =>
    request(server()).post(PATH).set('Authorization', auth).set('X-Correlation-Id', 'corr-1').send(body as object);

  it('F2-S1: publishes the batch keyed by the JWT driver and returns 202 { batchId, accepted }', async () => {
    const response = await send({ points: [point(1042, { accuracyMeters: 7 }), point(1041)] }).expect(202);

    expect(response.body).toEqual({ batchId: expect.any(String), accepted: 2 });
    expect(publisher.published).toHaveLength(1);
    const [envelope] = publisher.published;
    expect(envelope).toMatchObject({
      eventType: 'GpsBatchReceived',
      schemaVersion: 1,
      producer: 'gps-ingestion-api',
      correlationId: 'corr-1',
      aggregateId: DRIVER,
      aggregateVersion: null,
    });
    // The points are NOT processed: same order as sent, only normalised to UTC.
    expect(envelope.payload).toEqual({
      driverId: DRIVER,
      batchId: response.body.batchId,
      receivedAt: expect.any(String),
      points: [
        { lat: 6.2442, lng: -75.5812, deviceTime: '2026-10-18T15:20:01.000Z', sequence: 1042, accuracyMeters: 7 },
        { lat: 6.2442, lng: -75.5812, deviceTime: '2026-10-18T15:20:01.000Z', sequence: 1041 },
      ],
    });
  });

  it('accepts exactly 50 points', async () => {
    const points = Array.from({ length: 50 }, (_, index) => point(index));
    const response = await send({ points }).expect(202);
    expect(response.body.accepted).toBe(50);
  });

  it('normalises device times with an offset to UTC', async () => {
    await send({ points: [point(1, { deviceTime: '2026-10-18T10:20:01-05:00' })] }).expect(202);
    expect(publisher.published[0].payload.points[0].deviceTime).toBe('2026-10-18T15:20:01.000Z');
  });

  it.each([
    ['an empty batch', []],
    ['more than 50 points', Array.from({ length: 63 }, (_, index) => point(index))],
  ])('F2-S2: rejects %s with 400 and publishes nothing', async (_name, points) => {
    const response = await send({ points }).expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'https://api.fasttrack.local/errors/validation',
      status: 400,
      instance: PATH,
      correlationId: 'corr-1',
    });
    expect(response.body.errors).toContainEqual({
      field: 'points',
      message: 'A batch must contain between 1 and 50 points',
    });
    expect(publisher.published).toHaveLength(0);
  });

  it('rejects invalid coordinates, times and sequences, naming each field', async () => {
    const response = await send({
      points: [
        point(1, { lat: 91 }),
        point(2, { lng: -180.5 }),
        point(3, { deviceTime: '2026-10-18T15:20:01' }), // no time zone
        point(4, { deviceTime: '2026-02-30T10:00:00Z' }), // not a real date
        point(-1),
        point(5.5),
        point(6, { accuracyMeters: -1, speedKmh: 'fast' }),
      ],
    }).expect(400);

    const fields = response.body.errors.map((error: { field: string }) => error.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'points.0.lat',
        'points.1.lng',
        'points.2.deviceTime',
        'points.3.deviceTime',
        'points.4.sequence',
        'points.5.sequence',
        'points.6.accuracyMeters',
        'points.6.speedKmh',
      ]),
    );
    expect(publisher.published).toHaveLength(0);
  });

  it('rejects a driverId in the body: identity only comes from the JWT', async () => {
    const response = await send({ driverId: 'someone-else', points: [point(1)] }).expect(400);

    expect(response.body.errors.map((error: { field: string }) => error.field)).toContain('driverId');
    expect(publisher.published).toHaveLength(0);
  });

  it('rejects a body that is not a batch', async () => {
    await send({ points: 'nope' }).expect(400);
    await send({}).expect(400);
  });

  it('returns 413 problem+json for a body above the size limit', async () => {
    const response = await send({ points: [point(1)], padding: 'x'.repeat(70 * 1024) }).expect(413);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 413, type: 'https://api.fasttrack.local/errors/payload-too-large' });
    expect(publisher.published).toHaveLength(0);
  });

  it('returns 400 problem+json for malformed JSON', async () => {
    const response = await request(server())
      .post(PATH)
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .set('Content-Type', 'application/json')
      .send('{"points": [')
      .expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 400, type: 'https://api.fasttrack.local/errors/bad-request' });
    expect(publisher.published).toHaveLength(0);
  });

  it('returns 401 without a token and 403 for a role other than DRIVER', async () => {
    await request(server()).post(PATH).send({ points: [point(1)] }).expect(401);
    await send({ points: [point(1)] }, token(DRIVER, 'CUSTOMER')).expect(403);
    expect(publisher.published).toHaveLength(0);
  });

  it('returns 503 problem+json when Kafka does not confirm the batch', async () => {
    publisher.failure = new EventBusUnavailableError('broker down');

    const response = await send({ points: [point(1)] }).expect(503);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'https://api.fasttrack.local/errors/event-bus-unavailable',
      title: 'Event bus unavailable',
      status: 503,
    });
  });

  it('returns 500 (not 503) for an unexpected error', async () => {
    publisher.failure = new Error('bug');
    await send({ points: [point(1)] }).expect(500);
  });

  it('generates a correlation id when Kong did not add one', async () => {
    await request(server()).post(PATH).set('Authorization', token(DRIVER, 'DRIVER')).send({ points: [point(1)] }).expect(202);

    expect(publisher.published[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
