import type { AddressInfo, Server } from 'node:net';
import { Controller, Get, NotFoundException, Param, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import request from 'supertest';
import { setupHttpObservability } from './http.js';
import { startMetricsServer } from './metrics-server.js';
import { startTracing, stopTracing } from './tracing.js';

@Controller('orders')
class OrdersController {
  @Get(':orderId')
  get(@Param('orderId') orderId: string) {
    if (orderId === 'missing') throw new NotFoundException();
    return { orderId };
  }
}

describe('setupHttpObservability', () => {
  let app: INestApplication;
  let exporter: InMemorySpanExporter;

  beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    startTracing('test-service', { spanProcessor: new SimpleSpanProcessor({ exporter }) });
    const moduleRef = await Test.createTestingModule({ controllers: [OrdersController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupHttpObservability(app);
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await stopTracing();
  });

  it('serves the Prometheus registry on GET /metrics, outside /v1', async () => {
    await request(app.getHttpServer()).get('/v1/orders/6f1c').expect(200);

    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/v1\/orders\/:orderId"[^}]*status_code="200"[^}]*\} [1-9]/,
    );
  });

  it('labels by route template, never by the real path', async () => {
    await request(app.getHttpServer()).get('/v1/orders/missing').expect(404);
    await request(app.getHttpServer()).get('/v1/nothing-here').expect(404);

    const { text } = await request(app.getHttpServer()).get('/metrics');

    expect(text).toMatch(/route="\/v1\/orders\/:orderId"[^}]*status_code="404"/);
    expect(text).toMatch(/route="unmatched"/);
    expect(text).not.toContain('/v1/orders/missing');
  });

  it('opens a SERVER span whose trace id is the X-Correlation-Id', async () => {
    await request(app.getHttpServer())
      .get('/v1/orders/6f1c')
      .set('X-Correlation-Id', '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11')
      .expect(200);

    const span = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER)!;
    expect(span.name).toBe('GET /v1/orders/:orderId');
    expect(span.spanContext().traceId).toBe('0b7d0c1e3a554b8e9d2b5f0c2a9a7e11');
    expect(span.attributes).toMatchObject({ 'http.route': '/v1/orders/:orderId', 'http.response.status_code': 200 });
  });

  it('refuses anything but GET on /metrics', async () => {
    await request(app.getHttpServer()).post('/metrics').expect(405);
  });
});

describe('startMetricsServer', () => {
  let server: Server;

  beforeEach(async () => {
    server = await startMetricsServer(0);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  it('answers /metrics and /health, and 404 for anything else', async () => {
    const metrics = await request(url()).get('/metrics').expect(200);
    expect(metrics.text).toContain('# TYPE');

    const health = await request(url()).get('/health').expect(200);
    expect(health.body).toEqual({ status: 'UP' });

    await request(url()).get('/v1/anything').expect(404);
  });
});
