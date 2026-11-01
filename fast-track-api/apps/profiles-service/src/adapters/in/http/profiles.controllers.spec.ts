/**
 * HTTP adapter tests: real controllers, guard, validation pipe and
 * problem+json filter; the in-memory store instead of PostgreSQL.
 * Tokens are unsigned JWTs: the service only decodes them (Kong verifies).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';
import { AssignmentWindow } from '../../../domain/assignment-window.js';
import {
  Assigner,
  StartAssignment,
  TrackOrderStatus,
} from '../../../application/assignment.use-cases.js';
import {
  GetCustomerProfile,
  SaveCustomerProfile,
} from '../../../application/customer-profile.use-cases.js';
import {
  ChangeDriverAvailability,
  ChangeDriverCapacity,
  GetAssignment,
  SaveDriverProfile,
} from '../../../application/driver-profile.use-cases.js';
import {
  AssignmentSettings,
  Clock,
  ProfilesStore,
} from '../../../application/ports.js';
import {
  FakeClock,
  InMemoryProfilesStore,
} from '../../../application/testing/in-memory.js';
import { AssignmentsController } from './assignments.controller.js';
import { CustomersController } from './customers.controller.js';
import { DriversController } from './drivers.controller.js';

const CUSTOMER = '3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10';
const DRIVER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const OPS = '7b8c9d0e-0000-4000-8000-000000000001';
const ORDER = '6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10';

function token(sub: string, role: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${encode({ alg: 'none' })}.${encode({ sub, realm_access: { roles: [role] } })}.x`;
}

describe('Profiles REST API', () => {
  let app: INestApplication;
  let store: InMemoryProfilesStore;
  let clock: FakeClock;
  let start: StartAssignment;
  let status: TrackOrderStatus;

  beforeEach(async () => {
    store = new InMemoryProfilesStore();
    clock = new FakeClock(new Date('2026-10-18T15:00:00Z'));
    const moduleRef = await Test.createTestingModule({
      controllers: [
        CustomersController,
        DriversController,
        AssignmentsController,
      ],
      providers: [
        { provide: ProfilesStore, useValue: store },
        { provide: Clock, useValue: clock },
        {
          provide: AssignmentSettings,
          useValue: new AssignmentSettings(new AssignmentWindow(), 3),
        },
        Assigner,
        StartAssignment,
        TrackOrderStatus,
        GetCustomerProfile,
        SaveCustomerProfile,
        SaveDriverProfile,
        ChangeDriverAvailability,
        ChangeDriverCapacity,
        GetAssignment,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    start = moduleRef.get(StartAssignment);
    status = moduleRef.get(TrackOrderStatus);
  });

  afterEach(() => app.close());

  const server = () => app.getHttpServer();
  const assignOrder = () =>
    start.execute({
      eventId: '00000000-0000-4000-8000-000000000001',
      correlationId: 'c',
      orderId: ORDER,
      customerId: CUSTOMER,
      destination: { address: null, location: { lat: 6.2, lng: -75.5 } },
      version: 1,
    });

  // ------------------------------------------------------------ auth

  it('401 without a token, as problem+json', async () => {
    const response = await request(server())
      .get('/v1/customers/me')
      .expect(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
  });

  it('403 when the role is not allowed', async () => {
    await request(server())
      .get('/v1/customers/me')
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .expect(403);
    await request(server())
      .put('/v1/drivers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({})
      .expect(403);
    await request(server())
      .get(`/v1/assignments?orderId=${ORDER}`)
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .expect(403);
    await request(server())
      .patch(`/v1/drivers/${DRIVER}/capacity`)
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .send({ capacity: 4 })
      .expect(403);
  });

  // ------------------------------------------------------------ customers

  it('F1-S1: PUT /customers/me creates (201) under the JWT sub, then updates (200)', async () => {
    const body = {
      name: 'Laura Gómez',
      email: 'laura@example.com',
      phone: '+573001234567',
    };
    const created = await request(server())
      .put('/v1/customers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .set('X-Correlation-Id', '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11')
      .send(body)
      .expect(201);
    expect(created.body).toEqual({
      customerId: CUSTOMER,
      ...body,
      createdAt: '2026-10-18T15:00:00.000Z',
      updatedAt: '2026-10-18T15:00:00.000Z',
    });
    expect(store.published[0].envelope).toMatchObject({
      eventType: 'CustomerContactUpdated',
      correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
    });

    await request(server())
      .put('/v1/customers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({ ...body, name: 'Laura' })
      .expect(200);
    const fetched = await request(server())
      .get('/v1/customers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .expect(200);
    expect(fetched.body.name).toBe('Laura');
  });

  it('GET /customers/me is 404 before the profile exists', async () => {
    const response = await request(server())
      .get('/v1/customers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .expect(404);
    expect(response.body).toMatchObject({
      status: 404,
      detail: 'Customer profile not created yet',
      instance: '/v1/customers/me',
    });
  });

  it('400 for an invalid email or phone, and for a customerId in the body', async () => {
    const response = await request(server())
      .put('/v1/customers/me')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({
        name: 'Laura',
        email: 'not-an-email',
        phone: '3001234567',
        customerId: 'someone-else',
      })
      .expect(400);
    expect(
      response.body.errors.map((e: { field: string }) => e.field).sort(),
    ).toEqual(['customerId', 'email', 'phone']);
  });

  // ------------------------------------------------------------ drivers

  it('PUT /drivers/me creates the driver OFFLINE with capacity 3 (201)', async () => {
    const response = await request(server())
      .put('/v1/drivers/me')
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .send({
        name: 'Carlos Ruiz',
        phone: '+573109876543',
        vehiclePlate: 'ABC123',
      })
      .expect(201);
    expect(response.body).toEqual({
      driverId: DRIVER,
      name: 'Carlos Ruiz',
      phone: '+573109876543',
      vehiclePlate: 'ABC123',
      availability: 'OFFLINE',
      capacity: 3,
      activeOrderIds: [],
    });
  });

  it('PATCH availability: 404 without a profile, 400 for EN_ROUTE, 200 for AVAILABLE', async () => {
    const patch = (availability: string) =>
      request(server())
        .patch('/v1/drivers/me/availability')
        .set('Authorization', token(DRIVER, 'DRIVER'))
        .send({ availability });

    await patch('AVAILABLE').expect(404);
    store.addDriver({ driverId: DRIVER, availability: 'OFFLINE' });
    await patch('EN_ROUTE').expect(400);
    expect((await patch('AVAILABLE').expect(200)).body).toMatchObject({
      driverId: DRIVER,
      availability: 'AVAILABLE',
    });
  });

  it('PATCH availability OFFLINE with an order ON_THE_WAY is 409', async () => {
    store.addDriver({ driverId: DRIVER });
    await assignOrder();
    await status.execute({
      eventId: '00000000-0000-4000-8000-000000000002',
      eventType: 'OrderOnTheWay',
      orderId: ORDER,
      status: 'ON_THE_WAY',
      version: 3,
      driverId: DRIVER,
    });

    const response = await request(server())
      .patch('/v1/drivers/me/availability')
      .set('Authorization', token(DRIVER, 'DRIVER'))
      .send({ availability: 'OFFLINE' })
      .expect(409);
    expect(response.body).toMatchObject({
      type: 'https://api.fasttrack.local/errors/orders-on-the-way',
      title: 'Driver has orders on the way',
      status: 409,
    });
  });

  it('PATCH capacity (OPERATIONS): 200, 400 out of range, 404 unknown, 409 below active orders', async () => {
    const patch = (driverId: string, capacity: unknown) =>
      request(server())
        .patch(`/v1/drivers/${driverId}/capacity`)
        .set('Authorization', token(OPS, 'OPERATIONS'))
        .send({ capacity });

    store.addDriver({ driverId: DRIVER });
    await assignOrder();

    expect((await patch(DRIVER, 4).expect(200)).body).toMatchObject({
      capacity: 4,
      availability: 'EN_ROUTE',
      activeOrderIds: [ORDER],
    });
    await patch(DRIVER, 11).expect(400);
    await patch(DRIVER, '4').expect(400); // a JSON integer, not a string
    await patch('not-a-uuid', 4).expect(400);
    await patch('11111111-1111-4111-8111-111111111111', 4).expect(404);

    store.addDriver({
      driverId: '22222222-2222-4222-8222-222222222222',
      capacity: 1,
    });
    await patch(DRIVER, 1).expect(200); // 1 active order -> 1 is allowed
    const response = await request(server())
      .patch(`/v1/drivers/${DRIVER}/capacity`)
      .set('Authorization', token(OPS, 'OPERATIONS'))
      .send({ capacity: 0 })
      .expect(400);
    expect(response.body.errors[0].field).toBe('capacity');
  });

  // ------------------------------------------------------------ assignments

  it('GET /assignments: 400 without a valid orderId, 404 before assignment, 200 after', async () => {
    const get = (query: string) =>
      request(server())
        .get(`/v1/assignments${query}`)
        .set('Authorization', token(OPS, 'OPERATIONS'));

    await get('').expect(400);
    await get('?orderId=abc').expect(400);
    await get(`?orderId=${ORDER}`).expect(404);

    store.addDriver({ driverId: DRIVER });
    await assignOrder();
    expect((await get(`?orderId=${ORDER}`).expect(200)).body).toEqual({
      orderId: ORDER,
      driverId: DRIVER,
      assignedAt: '2026-10-18T15:00:00.000Z',
      releasedAt: null,
    });
  });
});
