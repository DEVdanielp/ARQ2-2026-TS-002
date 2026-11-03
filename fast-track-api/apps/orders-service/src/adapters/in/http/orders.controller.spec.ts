/**
 * HTTP adapter tests: real controller, guard, validation pipe and
 * problem+json filter; in-memory ports instead of PostgreSQL and Kafka.
 * Tokens are unsigned JWTs: the service only decodes them (Kong verifies).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';
import { newOrder, type OrderStatus } from '../../../domain/order.js';
import {
  CreateOrder,
  GetOrder,
  ListOrders,
  SubmitIntent,
} from '../../../application/orders.use-cases.js';
import {
  Clock,
  IntentPublisher,
  OrdersStore,
} from '../../../application/ports.js';
import {
  FakeClock,
  FakeIntentPublisher,
  InMemoryOrdersStore,
} from '../../../application/testing/in-memory.js';
import { OrdersController } from './orders.controller.js';

const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const DRIVER = '9a1b2c3d-0000-4000-8000-000000000001';
const OPS = '7b8c9d0e-0000-4000-8000-000000000001';
const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';
const KEY = '1f6e0c2a-77b1-4d0e-9a8f-2b3c4d5e6f70';
const DESTINATION = {
  address: 'Cra 43A #1-50, Medellín',
  location: { lat: 6.2088, lng: -75.5679 },
};

function token(sub: string, role: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${encode({ alg: 'none' })}.${encode({ sub, realm_access: { roles: [role] } })}.x`;
}

const asCustomer = token(CUSTOMER, 'CUSTOMER');
const asDriver = token(DRIVER, 'DRIVER');
const asOperations = token(OPS, 'OPERATIONS');

describe('OrdersController', () => {
  let app: INestApplication;
  let store: InMemoryOrdersStore;
  let publisher: FakeIntentPublisher;

  beforeEach(async () => {
    store = new InMemoryOrdersStore();
    publisher = new FakeIntentPublisher();
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        CreateOrder,
        GetOrder,
        ListOrders,
        SubmitIntent,
        { provide: OrdersStore, useValue: store },
        { provide: IntentPublisher, useValue: publisher },
        { provide: Clock, useValue: new FakeClock() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterEach(() => app.close());

  const server = () => app.getHttpServer();

  function seed(status: OrderStatus = 'CREATED', driverId = DRIVER): void {
    store.seed({
      ...newOrder({
        orderId: ORDER,
        customerId: CUSTOMER,
        destination: DESTINATION,
        notes: null,
        now: new Date('2026-10-18T14:00:00Z'),
      }),
      status,
      driverId,
      version: 2,
    });
  }

  describe('POST /v1/orders', () => {
    const body = { destination: DESTINATION, notes: 'Leave at reception' };

    it('201 with the order and its Location', async () => {
      const response = await request(server())
        .post('/v1/orders')
        .set('Authorization', asCustomer)
        .send(body)
        .expect(201);

      expect(response.body).toMatchObject({
        customerId: CUSTOMER,
        driverId: null,
        destination: DESTINATION,
        status: 'CREATED',
        version: 1,
        cancellation: null,
      });
      expect(response.body).not.toHaveProperty('notes');
      expect(response.headers.location).toBe(
        `/v1/orders/${response.body.orderId}`,
      );
    });

    it('401 without a token', async () => {
      await request(server()).post('/v1/orders').send(body).expect(401);
    });

    it('403 for a role other than CUSTOMER', async () => {
      await request(server())
        .post('/v1/orders')
        .set('Authorization', asDriver)
        .send(body)
        .expect(403);
    });

    it('400 with the field in error, as problem+json', async () => {
      const response = await request(server())
        .post('/v1/orders')
        .set('Authorization', asCustomer)
        .send({
          destination: {
            address: 'x',
            location: { lat: 91, lng: -75.5679 },
          },
        })
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      expect(response.body.errors[0].field).toBe('destination.location.lat');
    });

    it('400 without a destination, or with a customerId in the body', async () => {
      await request(server())
        .post('/v1/orders')
        .set('Authorization', asCustomer)
        .send({})
        .expect(400);
      await request(server())
        .post('/v1/orders')
        .set('Authorization', asCustomer)
        .send({ ...body, customerId: DRIVER })
        .expect(400);
    });

    it('400 for an Idempotency-Key that is not a UUID', async () => {
      await request(server())
        .post('/v1/orders')
        .set('Authorization', asCustomer)
        .set('Idempotency-Key', 'not-a-uuid')
        .send(body)
        .expect(400);
    });

    it('returns the same order on a repeated key; 409 with another body', async () => {
      const send = (payload: object) =>
        request(server())
          .post('/v1/orders')
          .set('Authorization', asCustomer)
          .set('Idempotency-Key', KEY)
          .send(payload);

      const first = await send(body).expect(201);
      const second = await send(body).expect(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers.location).toBe(first.headers.location);

      const conflict = await send({ destination: DESTINATION }).expect(409);
      expect(conflict.body.type).toMatch(/idempotency-key-reused$/);
    });
  });

  describe('GET /v1/orders/:orderId', () => {
    it('200 for the owner, the assigned driver and operations', async () => {
      seed();
      for (const caller of [asCustomer, asDriver, asOperations]) {
        const response = await request(server())
          .get(`/v1/orders/${ORDER}`)
          .set('Authorization', caller)
          .expect(200);
        expect(response.body).toMatchObject({ orderId: ORDER, version: 2 });
      }
    });

    it('403 for a customer who is not the owner', async () => {
      seed();
      await request(server())
        .get(`/v1/orders/${ORDER}`)
        .set('Authorization', token(DRIVER, 'CUSTOMER'))
        .expect(403);
    });

    it('404 for an unknown order, 400 for an invalid id', async () => {
      await request(server())
        .get(`/v1/orders/${ORDER}`)
        .set('Authorization', asOperations)
        .expect(404);
      await request(server())
        .get('/v1/orders/abc')
        .set('Authorization', asOperations)
        .expect(400);
    });
  });

  describe('GET /v1/orders', () => {
    it('lists with the default page and size', async () => {
      seed();
      const response = await request(server())
        .get('/v1/orders')
        .set('Authorization', asCustomer)
        .expect(200);

      expect(response.body).toMatchObject({ page: 0, size: 20, total: 1 });
      expect(response.body.items[0].orderId).toBe(ORDER);
    });

    it('filters by status and page', async () => {
      seed('ON_THE_WAY');
      const response = await request(server())
        .get('/v1/orders?status=CREATED&page=1&size=5')
        .set('Authorization', asOperations)
        .expect(200);

      expect(response.body).toEqual({ items: [], page: 1, size: 5, total: 0 });
    });

    it('400 for an invalid filter', async () => {
      for (const query of ['status=LOST', 'size=101', 'page=-1']) {
        await request(server())
          .get(`/v1/orders?${query}`)
          .set('Authorization', asOperations)
          .expect(400);
      }
    });
  });

  describe('POST /v1/orders/:orderId/intents', () => {
    const post = (caller: string, body: object) =>
      request(server())
        .post(`/v1/orders/${ORDER}/intents`)
        .set('Authorization', caller)
        .send(body);

    it('202 QUEUED for the assigned driver', async () => {
      seed();
      const response = await post(asDriver, {
        type: 'PICKUP_CONFIRMED',
      }).expect(202);

      expect(response.body).toMatchObject({
        orderId: ORDER,
        type: 'PICKUP_CONFIRMED',
        status: 'QUEUED',
      });
      expect(publisher.published).toHaveLength(1);
    });

    it('400 for an unknown type', async () => {
      seed();
      await post(asDriver, { type: 'TELEPORTED' }).expect(400);
    });

    it('F4-S5: 400 when operations gives no reason', async () => {
      seed('ON_THE_WAY');
      const response = await post(asOperations, {
        type: 'CANCELLATION_REQUESTED',
      }).expect(400);

      expect(response.body.errors).toEqual([
        { field: 'reason', message: 'required for OPERATIONS' },
      ]);
    });

    it('400 for a reason over 300 characters', async () => {
      seed('ON_THE_WAY');
      await post(asOperations, {
        type: 'CANCELLATION_REQUESTED',
        reason: 'x'.repeat(301),
      }).expect(400);
    });

    it('F4-S4: 403 for a customer cancelling after pickup', async () => {
      seed('ON_THE_WAY');
      await post(asCustomer, { type: 'CANCELLATION_REQUESTED' }).expect(403);
    });

    it('404 for an unknown order', async () => {
      await post(asDriver, { type: 'PICKUP_CONFIRMED' }).expect(404);
    });

    it('F4-S6: 409 with the type of the spec for a terminal order', async () => {
      seed('DELIVERED');
      const response = await post(asCustomer, {
        type: 'CANCELLATION_REQUESTED',
      }).expect(409);

      expect(response.body).toMatchObject({
        type: 'https://api.fasttrack.local/errors/order-terminal',
        title: 'Order is in a terminal state',
        detail: `Order ${ORDER} is DELIVERED.`,
      });
    });

    it('503 when Kafka does not confirm', async () => {
      seed();
      publisher.failing = true;
      await post(asDriver, { type: 'PICKUP_CONFIRMED' }).expect(503);
    });
  });
});
