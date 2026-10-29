import {
  DEFAULT_BROKERS,
  DEFAULT_PARTITIONS_CONSUMED_CONCURRENTLY,
  parseBrokers,
  resolveKafkaOptions,
} from './kafka.options.js';

describe('parseBrokers', () => {
  it('splits a comma-separated list and trims spaces', () => {
    expect(parseBrokers('kafka:19092, kafka2:19092 ,')).toEqual(['kafka:19092', 'kafka2:19092']);
  });

  it('returns an empty list for undefined', () => {
    expect(parseBrokers(undefined)).toEqual([]);
  });
});

describe('resolveKafkaOptions', () => {
  it('reads brokers from KAFKA_BROKERS by default', () => {
    const resolved = resolveKafkaOptions({ clientId: 'svc' }, { KAFKA_BROKERS: 'kafka:19092' });

    expect(resolved).toEqual({
      clientId: 'svc',
      brokers: ['kafka:19092'],
      partitionsConsumedConcurrently: DEFAULT_PARTITIONS_CONSUMED_CONCURRENTLY,
    });
  });

  it('prefers explicit brokers over the environment', () => {
    const resolved = resolveKafkaOptions(
      { clientId: 'svc', brokers: ['other:9092'] },
      { KAFKA_BROKERS: 'kafka:19092' },
    );

    expect(resolved.brokers).toEqual(['other:9092']);
  });

  it('falls back to localhost when nothing is configured', () => {
    expect(resolveKafkaOptions({ clientId: 'svc' }, {}).brokers).toEqual(DEFAULT_BROKERS);
  });

  it('requires a clientId', () => {
    expect(() => resolveKafkaOptions({ clientId: ' ' }, {})).toThrow(/clientId/);
  });

  it('rejects a non-positive concurrency', () => {
    expect(() =>
      resolveKafkaOptions({ clientId: 'svc', partitionsConsumedConcurrently: 0 }, {}),
    ).toThrow(/partitionsConsumedConcurrently/);
  });
});
