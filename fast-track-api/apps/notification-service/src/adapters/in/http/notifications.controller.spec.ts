/**
 * HTTP adapter tests: real controller, guard, validation pipe and
 * problem+json filter; in-memory repositories instead of PostgreSQL.
 * Tokens are unsigned JWTs: the service only decodes them (Kong verifies).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';
import { GetNotificationLog } from '../../../application/get-notification-log.js';
import { NotificationLogRepository, OrderRecipientRepository, PreferencesRepository, DeviceRepository } from '../../../application/ports.js';
import { ManagePreferences, RegisterDevice } from '../../../application/preferences.use-cases.js';
import {
  InMemoryDevices,
  InMemoryNotificationLog,
  InMemoryPreferences,
  InMemoryRecipients,
} from '../../../application/testing/in-memory.js';
import { NotificationsController } from './notifications.controller.js';

const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';
const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';

function token(sub: string, role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${encode({ alg: 'none' })}.${encode({ sub, realm_access: { roles: [role] } })}.x`;
}

describe('NotificationsController', () => {
  let app: INestApplication;
  const preferences = new InMemoryPreferences();
  const devices = new InMemoryDevices();
  const recipients = new InMemoryRecipients();
  const log = new InMemoryNotificationLog();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        ManagePreferences,
        RegisterDevice,
        GetNotificationLog,
        { provide: PreferencesRepository, useValue: preferences },
        { provide: DeviceRepository, useValue: devices },
        { provide: OrderRecipientRepository, useValue: recipients },
        { provide: NotificationLogRepository, useValue: log },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterAll(() => app.close());

  const server = () => app.getHttpServer();

  it('returns the default preferences when never set', async () => {
    const response = await request(server())
      .get('/v1/notifications/preferences')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .expect(200);

    expect(response.body).toEqual({ push: true, email: true, notifyOnCreated: false });
  });

  it('stores the preferences under the JWT subject', async () => {
    await request(server())
      .put('/v1/notifications/preferences')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({ push: true, email: false, notifyOnCreated: false })
      .expect(200, { push: true, email: false, notifyOnCreated: false });

    expect(preferences.rows.get(CUSTOMER)).toEqual({ push: true, email: false, notifyOnCreated: false });
  });

  it('rejects an invalid body with a problem+json listing the fields', async () => {
    const response = await request(server())
      .put('/v1/notifications/preferences')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({ push: 'yes', customerId: 'someone-else' })
      .expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.errors.map((error: { field: string }) => error.field)).toEqual(
      expect.arrayContaining(['push', 'email', 'customerId']),
    );
  });

  it('registers a device with 204', async () => {
    await request(server())
      .put('/v1/notifications/devices')
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .send({ deviceToken: 'fcm:abc', platform: 'ANDROID' })
      .expect(204);

    expect(await devices.findByCustomer(CUSTOMER)).toEqual([{ deviceToken: 'fcm:abc', platform: 'ANDROID' }]);
  });

  it('returns 401 without a token and 403 for a driver', async () => {
    await request(server()).get('/v1/notifications/preferences').expect(401);
    await request(server())
      .get('/v1/notifications/preferences')
      .set('Authorization', token('driver-1', 'DRIVER'))
      .expect(403);
  });

  it("serves the order log to its owner and 404 to another customer", async () => {
    recipients.rows.set(ORDER, CUSTOMER);
    const entry = await log.claim({ orderId: ORDER, type: 'ON_THE_WAY', channel: 'EMAIL' }, CUSTOMER);
    await log.markSent(entry.id, 1);

    const response = await request(server())
      .get(`/v1/notifications/orders/${ORDER}`)
      .set('Authorization', token(CUSTOMER, 'CUSTOMER'))
      .expect(200);
    expect(response.body).toEqual([
      expect.objectContaining({ orderId: ORDER, type: 'ON_THE_WAY', channel: 'EMAIL', status: 'SENT', attempts: 1 }),
    ]);

    await request(server())
      .get(`/v1/notifications/orders/${ORDER}`)
      .set('Authorization', token('11111111-0000-4000-8000-000000000000', 'CUSTOMER'))
      .expect(404);
  });
});
