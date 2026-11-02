import { parseIntentMessage } from './intent-message.js';

describe('parseIntentMessage', () => {
  it('parses a pickup intent from the Orders event envelope', () => {
    const event = {
      eventId: '11111111-1111-4111-8111-111111111111',
      eventType: 'PickupConfirmed',
      schemaVersion: 1,
      occurredAt: '2026-10-18T15:20:00.000Z',
      producer: 'orders-service',
      correlationId: '33333333-3333-4333-8333-333333333333',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      aggregateVersion: null,
      payload: {
        intentId: '11111111-1111-4111-8111-111111111111',
        orderId: '22222222-2222-4222-8222-222222222222',
        type: 'PICKUP_CONFIRMED',
        actor: 'DRIVER',
        actorId: '44444444-4444-4444-8444-444444444444',
        requestedAt: '2026-10-18T15:20:00.000Z',
      },
    };

    expect(
      parseIntentMessage(
        Buffer.from(JSON.stringify(event)),
        'orders.intents',
        3,
        '42',
      ),
    ).toMatchObject({
      event,
      intent: {
        intentId: event.eventId,
        type: 'PICKUP_CONFIRMED',
        actor: 'DRIVER',
        actorId: '44444444-4444-4444-8444-444444444444',
      },
      topic: 'orders.intents',
      partition: 3,
      offset: '42',
    });
  });

  it.each([
    null,
    Buffer.from('{'),
    Buffer.from(JSON.stringify({ eventId: 'not-an-envelope', payload: {} })),
  ])('rejects malformed or missing intent messages', (value) => {
    expect(() =>
      parseIntentMessage(value, 'orders.intents', 0, '0'),
    ).toThrow();
  });
});
