import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { describeSql, instrumentDataSource, instrumentRedis, traceClient, type DataSourceLike } from './client-spans.js';
import { runInSpan, startTracing, stopTracing } from './tracing.js';

const CORRELATION_ID = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';
const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
  runInSpan('POST /v1/orders', { kind: SpanKind.SERVER, correlationId: CORRELATION_ID }, work);

describe('describeSql', () => {
  it.each([
    ['SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', 'SELECT', 'orders'],
    ['  INSERT INTO outbox (topic) VALUES ($1)', 'INSERT', 'outbox'],
    ['UPDATE "public"."driver_routes" SET last_sequence = $2', 'UPDATE', 'driver_routes'],
    ['DELETE FROM idempotency_keys WHERE expires_at <= $1', 'DELETE', 'idempotency_keys'],
    ['START TRANSACTION', 'START TRANSACTION', undefined],
    ['COMMIT', 'COMMIT', undefined],
    ['ROLLBACK TO SAVEPOINT typeorm_1', 'ROLLBACK TO SAVEPOINT', undefined],
  ])('%s', (sql, operation, collection) => {
    expect(describeSql(sql)).toEqual(collection ? { operation, collection } : { operation });
  });

  it('names a SELECT without FROM after its function (advisory locks)', () => {
    expect(describeSql('SELECT pg_advisory_xact_lock(1903, hashtext($1))')).toEqual({
      operation: 'SELECT',
      function: 'pg_advisory_xact_lock',
    });
    expect(describeSql('SELECT 1')).toEqual({ operation: 'SELECT' });
  });
});

describe('client spans', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    startTracing('test-service', { spanProcessor: new SimpleSpanProcessor({ exporter }) });
  });

  afterEach(async () => {
    await stopTracing();
  });

  const spans = () => exporter.getFinishedSpans();
  const byName = (name: string) => spans().find((span) => span.name === name);

  it('creates no span outside a request or message', async () => {
    await expect(traceClient('smtp send', {}, async () => 'sent')).resolves.toBe('sent');
    expect(spans()).toHaveLength(0);
  });

  it('is a CLIENT child of the active span and records failures', async () => {
    await expect(
      inRequest(() =>
        traceClient('smtp send', { 'server.address': 'mailhog' }, async () => {
          throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        }),
      ),
    ).rejects.toThrow('connection refused');

    const client = byName('smtp send')!;
    const parent = byName('POST /v1/orders')!;
    expect(client.kind).toBe(SpanKind.CLIENT);
    expect(client.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(client.status.code).toBe(SpanStatusCode.ERROR);
    expect(client.attributes['error.type']).toBe('ECONNREFUSED');
  });

  describe('instrumentDataSource', () => {
    function fakeDataSource() {
      const executed: Array<{ sql: string; parameters?: unknown[] }> = [];
      const createRunner = () => ({
        query: async (sql: string, parameters?: unknown[]) => {
          executed.push({ sql, parameters });
          if (sql.startsWith('FAIL')) throw Object.assign(new Error('deadlock'), { code: '40P01' });
          return sql.startsWith('SELECT') ? [{ id: 1 }, { id: 2 }] : [];
        },
      });
      const dataSource: DataSourceLike = {
        options: { type: 'postgres', url: 'postgres://orders_db:secret@postgres:5432/orders_db' },
        createQueryRunner: createRunner,
        // Like TypeORM: the transaction runs its statements on a runner of this data source.
        async transaction(...args: unknown[]) {
          const work = args[0] as (runner: { query: (sql: string, p?: unknown[]) => Promise<unknown> }) => Promise<unknown>;
          const runner = dataSource.createQueryRunner();
          await runner.query('START TRANSACTION');
          const result = await work(runner);
          await runner.query('COMMIT');
          return result;
        },
      };
      return { dataSource, executed };
    }

    it('traces each statement with its operation and table, never its parameters', async () => {
      const { dataSource, executed } = fakeDataSource();
      instrumentDataSource(dataSource);

      const rows = await inRequest(() =>
        dataSource.createQueryRunner().query('SELECT * FROM orders WHERE customer_id = $1', ['secret-customer']),
      );

      expect(rows).toHaveLength(2);
      expect(executed[0].parameters).toEqual(['secret-customer']);
      const span = byName('SELECT orders')!;
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes).toMatchObject({
        'db.system.name': 'postgresql',
        'db.namespace': 'orders_db',
        'db.operation.name': 'SELECT',
        'db.collection.name': 'orders',
        'db.query.text': 'SELECT * FROM orders WHERE customer_id = $1',
        'db.response.returned_rows': 2,
        'server.address': 'postgres',
        'server.port': 5432,
      });
      expect(JSON.stringify(span.attributes)).not.toContain('secret');
    });

    it('groups the statements of a transaction under one span', async () => {
      const { dataSource } = fakeDataSource();
      instrumentDataSource(dataSource);
      instrumentDataSource(dataSource); // idempotent

      await inRequest(() =>
        dataSource.transaction(async (runner: { query: (sql: string) => Promise<unknown> }) => {
          await runner.query('UPDATE orders SET status = $2 WHERE order_id = $1');
          await runner.query('INSERT INTO outbox (topic) VALUES ($1)');
        }),
      );

      const transaction = byName('orders_db transaction')!;
      const names = spans()
        .filter((span) => span.parentSpanContext?.spanId === transaction.spanContext().spanId)
        .map((span) => span.name);
      expect(names).toEqual(['START TRANSACTION orders_db', 'UPDATE orders', 'INSERT outbox', 'COMMIT orders_db']);
    });

    it('records a failed statement with its SQLSTATE', async () => {
      const { dataSource } = fakeDataSource();
      instrumentDataSource(dataSource);

      await expect(inRequest(() => dataSource.createQueryRunner().query('FAIL'))).rejects.toThrow('deadlock');
      const span = byName('FAIL orders_db')!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('40P01');
    });

    it('does not trace statements outside a request (outbox relay, migrations)', async () => {
      const { dataSource } = fakeDataSource();
      instrumentDataSource(dataSource);
      await dataSource.createQueryRunner().query('SELECT * FROM outbox');
      expect(spans()).toHaveLength(0);
    });
  });

  describe('instrumentRedis', () => {
    function fakeRedis(fail = false) {
      return {
        options: { host: 'redis', port: 6379, db: 0 },
        sendCommand(command: { promise: Promise<unknown> }) {
          return command.promise;
        },
        command(name: string, args: unknown[]) {
          const promise = fail ? Promise.reject(new Error('READONLY')) : Promise.resolve('OK');
          return this.sendCommand({ name, args, promise } as never);
        },
      };
    }

    it('traces commands with the key, never the values', async () => {
      const redis = fakeRedis();
      instrumentRedis(redis);

      await inRequest(async () => {
        await redis.command('hgetall', ['tracking:view:o-1']);
        await redis.command('evalsha', ['abc123', '1', 'tracking:view:o-1', '{"email":"ana@example.com"}']);
      });

      expect(byName('HGETALL')!.attributes).toMatchObject({
        'db.system.name': 'redis',
        'db.namespace': '0',
        'db.query.summary': 'HGETALL tracking:view:o-1',
      });
      expect(byName('EVALSHA')!.attributes['db.query.summary']).toBe('EVALSHA tracking:view:o-1');
      expect(JSON.stringify(spans().map((span) => span.attributes))).not.toContain('ana@example.com');
    });

    it('marks a failed command and still rejects the caller', async () => {
      const redis = fakeRedis(true);
      instrumentRedis(redis);

      await expect(inRequest(() => redis.command('get', ['k']) as Promise<unknown>)).rejects.toThrow('READONLY');
      expect(byName('GET')!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });
});
