import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { createLogger, FastTrackLogger, logLevelsFor } from './logger.js';
import { runInSpan, startTracing, stopTracing } from './tracing.js';

describe('logLevelsFor', () => {
  it('maps LOG_LEVEL to the Nest levels that are printed', () => {
    expect(logLevelsFor('error')).toEqual(['fatal', 'error']);
    expect(logLevelsFor('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(logLevelsFor('info')).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(logLevelsFor('DEBUG')).toEqual(['fatal', 'error', 'warn', 'log', 'debug']);
    expect(logLevelsFor('verbose')).toHaveLength(6);
  });

  it('falls back to info when unset or unknown', () => {
    expect(logLevelsFor(undefined)).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(logLevelsFor('loud')).toEqual(['fatal', 'error', 'warn', 'log']);
  });
});

describe('FastTrackLogger', () => {
  let lines: string[];
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lines = [];
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    write.mockRestore();
    await stopTracing();
  });

  const lastJson = () => JSON.parse(lines.at(-1)!) as Record<string, unknown>;

  it('with LOG_FORMAT=json writes one JSON object with the service and the message object', () => {
    const logger = createLogger('notification-service', { LOG_FORMAT: 'json' });

    logger.log({ msg: 'Event processed', correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11' }, 'Consumer');

    const line = lines.at(-1)!;
    expect(line).toContain('"correlationId":"0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11"');
    expect(lastJson()).toMatchObject({ level: 'log', service: 'notification-service', context: 'Consumer' });
    expect(lastJson()).not.toHaveProperty('traceId');
  });

  it('adds the trace and span ids when the line is written inside a span', async () => {
    startTracing('notification-service', {
      spanProcessor: new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() }),
    });
    const logger = new FastTrackLogger('notification-service', { json: true });

    await runInSpan('work', { correlationId: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11' }, async () => {
      logger.log('inside');
    });

    expect(lastJson()).toMatchObject({ traceId: '0b7d0c1e3a554b8e9d2b5f0c2a9a7e11', message: 'inside' });
    expect(lastJson().spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('respects LOG_LEVEL', () => {
    const logger = createLogger('notification-service', { LOG_FORMAT: 'json', LOG_LEVEL: 'warn' });

    logger.log('hidden');
    logger.warn('shown');

    expect(lines).toHaveLength(1);
    expect(lastJson()).toMatchObject({ level: 'warn', message: 'shown' });
  });
});
