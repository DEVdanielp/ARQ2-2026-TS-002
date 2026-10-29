import {
  createEnvelope,
  InvalidEnvelopeError,
  parseEnvelope,
  type CreateEnvelopeInput,
} from './event-envelope.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const input: CreateEnvelopeInput<{ driverId: string }> = {
  eventType: 'GpsBatchReceived',
  schemaVersion: 1,
  producer: 'gps-ingestion-api',
  correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11',
  aggregateId: '9a1b2c3d-0000-4000-8000-000000000001',
  payload: { driverId: '9a1b2c3d-0000-4000-8000-000000000001' },
};

describe('createEnvelope', () => {
  it('generates a UUID v4 eventId and an ISO-8601 UTC occurredAt', () => {
    const envelope = createEnvelope(input);

    expect(envelope.eventId).toMatch(UUID_V4);
    expect(envelope.occurredAt).toMatch(ISO_UTC);
  });

  it('generates a different eventId for every call', () => {
    expect(createEnvelope(input).eventId).not.toBe(createEnvelope(input).eventId);
  });

  it('copies the fields provided by the publisher', () => {
    const envelope = createEnvelope({ ...input, aggregateVersion: 3 });

    expect(envelope).toMatchObject({ ...input, aggregateVersion: 3 });
  });

  it('defaults aggregateVersion to null', () => {
    expect(createEnvelope(input).aggregateVersion).toBeNull();
  });

  it('contains exactly the fields of the spec', () => {
    expect(Object.keys(createEnvelope(input)).sort()).toEqual(
      [
        'aggregateId',
        'aggregateVersion',
        'correlationId',
        'eventId',
        'eventType',
        'occurredAt',
        'payload',
        'producer',
        'schemaVersion',
      ].sort(),
    );
  });
});

describe('parseEnvelope', () => {
  it('parses a serialized envelope back to the same object', () => {
    const envelope = createEnvelope(input);

    expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });

  it.each([
    ['null value', null],
    ['empty value', ''],
    ['invalid JSON', '{not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseEnvelope(raw)).toThrow(InvalidEnvelopeError);
  });

  it('rejects an object without the required metadata', () => {
    const { eventId: _omitted, ...withoutId } = createEnvelope(input);

    expect(() => parseEnvelope(JSON.stringify(withoutId))).toThrow(/eventId/);
  });

  it('rejects an object without payload', () => {
    const { payload: _omitted, ...withoutPayload } = createEnvelope(input);

    expect(() => parseEnvelope(JSON.stringify(withoutPayload))).toThrow(/payload/);
  });
});
