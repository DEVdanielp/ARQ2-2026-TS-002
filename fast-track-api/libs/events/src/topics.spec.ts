import { dlqTopic, Topics } from './topics.js';

describe('Topics', () => {
  it('matches the topic list of spec section 5.1', () => {
    expect(Object.values(Topics).sort()).toEqual(
      [
        'gps.batches',
        'orders.intents',
        'orders.events',
        'assignment.events',
        'profile.events',
        'tracking.locations',
        'tracking.proximity',
        'notifications.retry',
      ].sort(),
    );
  });
});

describe('dlqTopic', () => {
  it('appends .dlq to the source topic', () => {
    expect(dlqTopic(Topics.GPS_BATCHES)).toBe('gps.batches.dlq');
    expect(dlqTopic(Topics.ORDERS_EVENTS)).toBe('orders.events.dlq');
  });
});
