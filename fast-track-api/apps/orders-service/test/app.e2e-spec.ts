import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { OrdersServiceModule } from './../src/orders-service.module.js';
import { ORDERS_REPOSITORY } from './../src/application/orders-repository.port.js';

describe('Orders REST API', () => {
  let app: INestApplication<App>;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const issuer = 'https://keycloak.test/realms/fasttrack';
  const previousJwtPublicKey = process.env.JWT_PUBLIC_KEY;
  const previousKeycloakIssuer = process.env.KEYCLOAK_ISSUER;
  const customerId = '22222222-2222-4222-8222-222222222222';
  const repository = {
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    findIdempotentResponse: vi.fn(),
    listOrders: vi.fn(),
    queueIntent: vi.fn(),
  };

  function token(roles: string[], subject = customerId): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const claims = Buffer.from(
      JSON.stringify({
        sub: subject,
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) + 60,
        realm_access: { roles },
      }),
    ).toString('base64url');
    const input = `${header}.${claims}`;
    const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString(
      'base64url',
    );
    return `${input}.${signature}`;
  }

  beforeAll(async () => {
    process.env.JWT_PUBLIC_KEY = publicKey.export({
      type: 'spki',
      format: 'pem',
    }).toString();
    process.env.KEYCLOAK_ISSUER = issuer;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [OrdersServiceModule],
    })
      .overrideProvider(ORDERS_REPOSITORY)
      .useValue(repository)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    if (previousJwtPublicKey === undefined) {
      delete process.env.JWT_PUBLIC_KEY;
    } else {
      process.env.JWT_PUBLIC_KEY = previousJwtPublicKey;
    }
    if (previousKeycloakIssuer === undefined) {
      delete process.env.KEYCLOAK_ISSUER;
    } else {
      process.env.KEYCLOAK_ISSUER = previousKeycloakIssuer;
    }
  });

  it('creates an order for a customer and returns Location', async () => {
    const order = {
      orderId: '11111111-1111-4111-8111-111111111111',
      customerId,
      driverId: null,
      destination: {
        address: 'Cra 43A #1-50, Medellín',
        location: { lat: 6.2088, lng: -75.5679 },
      },
      status: 'CREATED',
      version: 1,
      cancellation: null,
      createdAt: '2026-10-18T15:01:00.000Z',
      updatedAt: '2026-10-18T15:01:00.000Z',
    };
    repository.createOrder.mockResolvedValue({
      status: 201,
      body: order,
      headers: { Location: `/v1/orders/${order.orderId}` },
    });

    await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token(['CUSTOMER'])}`)
      .send({ destination: order.destination })
      .expect('Content-Type', /application\/json/)
      .expect('Location', `/v1/orders/${order.orderId}`)
      .expect(201, order);
  });

  it('uses the JWT role and returns an RFC 7807 forbidden error', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token(['DRIVER'])}`)
      .send({
        destination: {
          address: 'Somewhere',
          location: { lat: 0, lng: 0 },
        },
      })
      .expect(403)
      .expect('Content-Type', /application\/problem\+json/);

    expect(response.body).toMatchObject({
      status: 403,
      title: 'Forbidden',
      type: 'https://api.fasttrack.local/errors/http-403',
    });
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('rejects an invalid JWT signature', async () => {
    const [header, claims, encodedSignature] = token(['CUSTOMER']).split('.');
    const signature = Buffer.from(encodedSignature, 'base64url');
    signature[0] ^= 1;
    const tampered = `${header}.${claims}.${signature.toString('base64url')}`;

    await request(app.getHttpServer())
      .get('/v1/orders')
      .set('Authorization', `Bearer ${tampered}`)
      .expect(401)
      .expect('Content-Type', /application\/problem\+json/);
  });

  it('returns validation details as problem+json', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token(['CUSTOMER'])}`)
      .send({
        destination: {
          address: 'Somewhere',
          location: { lat: 91, lng: 0 },
        },
      })
      .expect(400)
      .expect('Content-Type', /application\/problem\+json/);

    expect(response.body.errors).toEqual([
      {
        field: 'destination.location.lat',
        message: 'Latitude must be between -90 and 90.',
      },
    ]);
  });
});
