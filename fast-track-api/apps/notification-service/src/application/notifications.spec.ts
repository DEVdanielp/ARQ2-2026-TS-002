/**
 * Use-case tests, named after the F5 scenarios of docs/spec.md section 6.
 */
import { createEnvelope } from '@libs/events';
import { AlertOperations } from './alert-operations.js';
import { ChannelDelivery, RecipientDirectory } from './delivery.js';
import { OrderNotVisibleError, RecipientNotFoundError } from './errors.js';
import { GetNotificationLog } from './get-notification-log.js';
import { NotifyCustomer } from './notify-customer.js';
import { ManagePreferences } from './preferences.use-cases.js';
import { ReplicateCustomerContact } from './replication.use-cases.js';
import { RetryNotification } from './retry-notification.js';
import { RetryPolicy } from './retry-policy.js';
import {
  FakeEmailSender,
  FakePushSender,
  InMemoryContacts,
  InMemoryDevices,
  InMemoryNotificationLog,
  InMemoryPreferences,
  InMemoryProcessedEvents,
  InMemoryRecipients,
  TEST_SETTINGS,
} from './testing/in-memory.js';

const ORDER = '6f1c2b7e-0000-4000-8000-000000000001';
const CUSTOMER = '3c9f8a2e-0000-4000-8000-000000000001';

function setup() {
  const preferences = new InMemoryPreferences();
  const devices = new InMemoryDevices();
  const contacts = new InMemoryContacts();
  const recipients = new InMemoryRecipients();
  const log = new InMemoryNotificationLog();
  const email = new FakeEmailSender();
  const push = new FakePushSender();
  const directory = new RecipientDirectory(contacts, devices);
  const delivery = new ChannelDelivery(email, push);
  const retries = new RetryPolicy(log, TEST_SETTINGS);

  recipients.rows.set(ORDER, CUSTOMER);
  contacts.rows.set(CUSTOMER, {
    contact: { customerId: CUSTOMER, name: 'Laura', email: 'laura@example.com', phone: null },
    version: 1,
  });
  devices.rows.set('token-1', { customerId: CUSTOMER, device: { deviceToken: 'token-1', platform: 'ANDROID' } });

  return {
    preferences,
    devices,
    contacts,
    recipients,
    log,
    email,
    push,
    notify: new NotifyCustomer(recipients, preferences, log, directory, delivery, retries),
    retry: new RetryNotification(log, directory, delivery, retries),
  };
}

const notifyCommand = (type: 'ON_THE_WAY' | 'NEARBY' | 'DELIVERED' | 'ORDER_CREATED') => ({
  orderId: ORDER,
  type,
  correlationId: 'corr-1',
});

describe('NotifyCustomer', () => {
  it('F5-S3: notifies once per type through push and email', async () => {
    const t = setup();

    const result = await t.notify.execute(notifyCommand('ON_THE_WAY'));

    expect(result.channels).toEqual({ PUSH: 'SENT', EMAIL: 'SENT' });
    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0]).toMatchObject({ to: 'laura@example.com', subject: 'FastTrack: Your order is on the way' });
    expect(t.push.sent).toHaveLength(1);
    expect(t.log.rows.map((row) => row.status)).toEqual(['SENT', 'SENT']);
  });

  it('F5-S2: a redelivered or repeated event does not notify twice', async () => {
    const t = setup();

    await t.notify.execute(notifyCommand('NEARBY'));
    const second = await t.notify.execute(notifyCommand('NEARBY'));

    expect(second.channels).toEqual({ PUSH: 'SKIPPED_DUPLICATE', EMAIL: 'SKIPPED_DUPLICATE' });
    expect(t.email.sent).toHaveLength(1);
    expect(t.push.sent).toHaveLength(1);
  });

  it('F5-S5: never sends email when the customer disabled it', async () => {
    const t = setup();
    await t.preferences.save(CUSTOMER, { push: true, email: false, notifyOnCreated: false });

    const result = await t.notify.execute(notifyCommand('DELIVERED'));

    expect(result.channels).toEqual({ PUSH: 'SENT' });
    expect(t.email.sent).toHaveLength(0);
  });

  it('sends ORDER_CREATED only to customers who opted in', async () => {
    const t = setup();
    expect((await t.notify.execute(notifyCommand('ORDER_CREATED'))).skipped).toBe('NOT_OPTED_IN');

    await t.preferences.save(CUSTOMER, { push: true, email: true, notifyOnCreated: true });
    expect((await t.notify.execute(notifyCommand('ORDER_CREATED'))).channels).toEqual({ PUSH: 'SENT', EMAIL: 'SENT' });
  });

  it('ignores a NEARBY that arrives after the order was delivered', async () => {
    const t = setup();
    await t.notify.execute(notifyCommand('DELIVERED'));

    expect((await t.notify.execute(notifyCommand('NEARBY'))).skipped).toBe('ORDER_FINISHED');
  });

  it('throws when OrderCreated was not processed yet, so the consumer retries', async () => {
    const t = setup();
    t.recipients.rows.clear();

    await expect(t.notify.execute(notifyCommand('ON_THE_WAY'))).rejects.toThrow(RecipientNotFoundError);
  });

  it('F5-S4: a provider failure schedules a retry in 1 min instead of failing the event', async () => {
    const t = setup();
    t.push.failing = true;

    const result = await t.notify.execute(notifyCommand('NEARBY'));

    expect(result.channels).toEqual({ PUSH: 'RETRYING', EMAIL: 'SENT' });
    const pushRow = t.log.rows.find((row) => row.channel === 'PUSH');
    expect(pushRow).toMatchObject({ status: 'RETRYING', attempts: 1, lastError: 'FCM 503 Service Unavailable' });
    expect(t.log.outbox).toHaveLength(1);
    expect(t.log.outbox[0].envelope.payload).toMatchObject({ type: 'NEARBY', channel: 'PUSH', attempt: 1 });
    const delayMs = t.log.outbox[0].publishAfter!.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(55_000);
    expect(delayMs).toBeLessThanOrEqual(60_000);
  });
});

describe('RetryNotification', () => {
  /** Runs the first send with push failing, returns the scheduled retry envelope. */
  async function firstFailure(t: ReturnType<typeof setup>) {
    t.push.failing = true;
    await t.notify.execute(notifyCommand('NEARBY'));
    return t.log.outbox.at(-1)!.envelope;
  }

  it('sends on retry and marks SENT with the total attempts', async () => {
    const t = setup();
    const retry = await firstFailure(t);
    t.push.failing = false;

    expect(await t.retry.execute(retry)).toBe('SENT');
    expect(t.log.rows.find((row) => row.channel === 'PUSH')).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('F5-S4: after the 3rd failed retry the notification is dead-lettered', async () => {
    const t = setup();
    let envelope = await firstFailure(t);

    expect(await t.retry.execute(envelope)).toBe('RETRYING'); // retry 1 fails -> retry 2 in 5 min
    envelope = t.log.outbox.at(-1)!.envelope;
    expect(await t.retry.execute(envelope)).toBe('RETRYING'); // retry 2 fails -> retry 3 in 15 min
    envelope = t.log.outbox.at(-1)!.envelope;
    expect(await t.retry.execute(envelope)).toBe('DEAD_LETTERED');

    expect(t.log.outbox.map((entry) => entry.topic)).toEqual([
      'notifications.retry',
      'notifications.retry',
      'notifications.retry',
      'notifications.retry.dlq',
    ]);
    expect(t.log.rows.find((row) => row.channel === 'PUSH')).toMatchObject({ status: 'DEAD_LETTERED', attempts: 4 });
  });

  it('ignores a duplicate of a retry that was already handled', async () => {
    const t = setup();
    const retry = await firstFailure(t);
    t.push.failing = false;
    await t.retry.execute(retry);

    expect(await t.retry.execute(retry)).toBe('IGNORED');
    expect(t.push.sent).toHaveLength(1);
  });
});

describe('ManagePreferences', () => {
  it('returns the defaults without storing them, then the saved values', async () => {
    const preferences = new InMemoryPreferences();
    const useCase = new ManagePreferences(preferences);

    expect(await useCase.get(CUSTOMER)).toEqual({ push: true, email: true, notifyOnCreated: false });
    expect(preferences.rows.size).toBe(0);

    await useCase.update(CUSTOMER, { push: false, email: true, notifyOnCreated: true });
    expect(await useCase.get(CUSTOMER)).toEqual({ push: false, email: true, notifyOnCreated: true });
  });
});

describe('ReplicateCustomerContact', () => {
  it('keeps the copy with the highest aggregateVersion', async () => {
    const contacts = new InMemoryContacts();
    const useCase = new ReplicateCustomerContact(contacts);
    const contact = { customerId: CUSTOMER, name: 'Laura', email: 'new@example.com', phone: null };

    await useCase.execute(contact, 3);
    const applied = await useCase.execute({ ...contact, email: 'old@example.com' }, 2);

    expect(applied).toBe(false);
    expect((await contacts.find(CUSTOMER))?.email).toBe('new@example.com');
  });
});

describe('AlertOperations', () => {
  it('emails the operations mailbox once per event', async () => {
    const processed = new InMemoryProcessedEvents();
    const email = new FakeEmailSender();
    const useCase = new AlertOperations(processed, email, TEST_SETTINGS);
    const event = createEnvelope({
      eventType: 'AssignmentFailed',
      schemaVersion: 1,
      producer: 'profiles-service',
      correlationId: 'corr-1',
      aggregateId: ORDER,
      payload: { orderId: ORDER, attempts: 20 },
    });

    expect(await useCase.execute(event)).toBe(true);
    expect(await useCase.execute(event)).toBe(false);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('ops@fasttrack.local');
  });
});

describe('GetNotificationLog', () => {
  async function setupLog() {
    const recipients = new InMemoryRecipients();
    const log = new InMemoryNotificationLog();
    recipients.rows.set(ORDER, CUSTOMER);
    const entry = await log.claim({ orderId: ORDER, type: 'ON_THE_WAY', channel: 'PUSH' }, CUSTOMER);
    await log.markSent(entry.id, 1);
    return new GetNotificationLog(recipients, log);
  }

  it('lets the owner read the log of their order', async () => {
    const useCase = await setupLog();
    const entries = await useCase.execute(ORDER, { userId: CUSTOMER, roles: ['CUSTOMER'] });

    expect(entries).toEqual([
      expect.objectContaining({ orderId: ORDER, type: 'ON_THE_WAY', channel: 'PUSH', status: 'SENT', attempts: 1 }),
    ]);
  });

  it("hides another customer's order as not found", async () => {
    const useCase = await setupLog();

    await expect(useCase.execute(ORDER, { userId: 'someone-else', roles: ['CUSTOMER'] })).rejects.toThrow(
      OrderNotVisibleError,
    );
  });

  it('lets operations read any order', async () => {
    const useCase = await setupLog();

    expect(await useCase.execute(ORDER, { userId: 'ops-1', roles: ['OPERATIONS'] })).toHaveLength(1);
  });
});
