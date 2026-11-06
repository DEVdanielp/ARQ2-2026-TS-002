/**
 * CLIENT spans for calls from a service to its dependencies: PostgreSQL,
 * Redis, SMTP, FCM and the Maps/ETA provider.
 *
 * Child spans only
 * ----------------
 * A client span is created only inside an active span (an HTTP request or a
 * consumed Kafka message). Background loops that are not part of a business
 * flow (the outbox relay polling every few hundred ms, schedulers, migrations
 * at startup) run untraced, so they do not flood Jaeger with one-span traces.
 *
 * No values are recorded
 * ----------------------
 * SQL is recorded as written by the adapters, with `$1, $2...` placeholders;
 * parameters are never attached. For Redis only the command name and the key
 * are recorded, never the values (the tracking views hold customer data).
 *
 * No monkey patching of modules
 * -----------------------------
 * The OpenTelemetry auto-instrumentations hook `require`/`import`, which does
 * not work well with ESM services bundled by rspack. Instead, the instances we
 * already create (TypeORM's DataSource, the ioredis client) are wrapped once at
 * startup, and providers call `traceClient()` explicitly.
 *
 * Attribute names follow the OpenTelemetry semantic conventions (db.*,
 * server.*, http.*).
 */
import { context, SpanKind, trace, type Attributes, type Span } from '@opentelemetry/api';
import { markSpanFailed, startSpan } from './tracing.js';

/** Longest SQL text kept on a span. */
const MAX_QUERY_TEXT = 2_000;

/**
 * Runs `work` inside a CLIENT span named `name`, as a child of the active span.
 * Without an active span it just runs `work`. A thrown error is recorded on the
 * span and rethrown.
 */
export async function traceClient<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (!trace.getSpan(context.active())) return work(undefined);
  const { span, ctx } = startSpan(name, { kind: SpanKind.CLIENT, attributes });
  return context.with(ctx, async () => {
    try {
      return await work(span);
    } catch (error) {
      span.setAttribute('error.type', errorType(error));
      markSpanFailed(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The most specific error code available: SQLSTATE, errno or class name. */
function errorType(error: unknown): string {
  const failure = error as { code?: unknown; driverError?: { code?: unknown }; name?: unknown } | undefined;
  const code = failure?.driverError?.code ?? failure?.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return typeof failure?.name === 'string' ? failure.name : 'Error';
}

// ───────────────────────────── PostgreSQL (TypeORM) ─────────────────────────────

/** The part of TypeORM's QueryRunner that is wrapped. */
interface QueryRunnerLike {
  query(query: string, parameters?: unknown[], ...rest: unknown[]): Promise<unknown>;
}

/** The part of TypeORM's DataSource that is wrapped (no import of typeorm here). */
export interface DataSourceLike {
  options: { type?: string; database?: unknown; url?: unknown };
  createQueryRunner(...args: unknown[]): QueryRunnerLike;
  transaction(...args: unknown[]): Promise<unknown>;
}

const INSTRUMENTED = Symbol('fasttrack.instrumented');

const TRANSACTION_CONTROL = /^\s*(START TRANSACTION|BEGIN|COMMIT|ROLLBACK TO SAVEPOINT|ROLLBACK|RELEASE SAVEPOINT|SAVEPOINT)\b/i;

/**
 * `db.operation.name` and `db.collection.name` of a SQL statement:
 * `SELECT ... FROM orders ... FOR UPDATE` → `{ operation: 'SELECT', collection: 'orders' }`.
 * A `SELECT fn(...)` without FROM (advisory locks) reports the function instead:
 * `SELECT pg_advisory_xact_lock(...)` → `{ operation: 'SELECT', function: 'pg_advisory_xact_lock' }`.
 */
export function describeSql(sql: string): { operation: string; collection?: string; function?: string } {
  const control = TRANSACTION_CONTROL.exec(sql);
  if (control) return { operation: control[1].toUpperCase() };
  const operation = (/^\s*(\w+)/.exec(sql)?.[1] ?? 'QUERY').toUpperCase();
  const tablePattern: Record<string, RegExp> = {
    SELECT: /\bFROM\s+((?:"?\w+"?\.)?"?\w+"?)/i,
    DELETE: /\bFROM\s+((?:"?\w+"?\.)?"?\w+"?)/i,
    INSERT: /\bINTO\s+((?:"?\w+"?\.)?"?\w+"?)/i,
    UPDATE: /^\s*UPDATE\s+((?:"?\w+"?\.)?"?\w+"?)/i,
    WITH: /\b(?:INTO|UPDATE|FROM)\s+((?:"?\w+"?\.)?"?\w+"?)/i,
  };
  const table = tablePattern[operation]?.exec(sql)?.[1];
  const collection = table?.replace(/"/g, '').split('.').pop();
  if (collection) return { operation, collection };
  const fn = operation === 'SELECT' ? /^\s*SELECT\s+(\w+)\s*\(/i.exec(sql)?.[1] : undefined;
  return fn ? { operation, function: fn } : { operation };
}

function databaseOf(options: DataSourceLike['options']): { name?: string; host?: string; port?: number } {
  const database = typeof options.database === 'string' ? options.database : undefined;
  if (typeof options.url !== 'string') return { name: database };
  try {
    const url = new URL(options.url);
    return {
      name: decodeURIComponent(url.pathname.replace(/^\//, '')) || database,
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
    };
  } catch {
    return { name: database };
  }
}

/**
 * Traces every SQL statement run through `dataSource` (raw `query()`,
 * repositories, query builders, BEGIN/COMMIT) as a CLIENT span named
 * `<OPERATION> <table>`, e.g. `SELECT orders`, `INSERT outbox`, `COMMIT`, and
 * every `dataSource.transaction()` as a `<database> transaction` span that
 * groups them. Call it once, at startup. Idempotent.
 */
export function instrumentDataSource(dataSource: DataSourceLike): void {
  const target = dataSource as DataSourceLike & { [INSTRUMENTED]?: boolean };
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;

  const database = databaseOf(dataSource.options);
  const base: Attributes = {
    'db.system.name': dataSource.options.type === 'postgres' ? 'postgresql' : (dataSource.options.type ?? 'sql'),
    ...(database.name ? { 'db.namespace': database.name } : {}),
    ...(database.host ? { 'server.address': database.host } : {}),
    ...(database.port ? { 'server.port': database.port } : {}),
  };

  const createQueryRunner = dataSource.createQueryRunner.bind(dataSource);
  dataSource.createQueryRunner = (...args: unknown[]) => {
    const runner = createQueryRunner(...args);
    const query = runner.query.bind(runner);
    runner.query = (sql: string, parameters?: unknown[], ...rest: unknown[]) => {
      const { operation, collection, function: fn } = describeSql(sql);
      return traceClient(
        `${operation} ${collection ?? fn ?? database.name ?? ''}`.trim(),
        {
          ...base,
          'db.operation.name': operation,
          ...(collection ? { 'db.collection.name': collection } : {}),
          'db.query.text': sql.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_TEXT),
        },
        async (span) => {
          const result = await query(sql, parameters, ...rest);
          if (span && Array.isArray(result)) span.setAttribute('db.response.returned_rows', result.length);
          return result;
        },
      );
    };
    return runner;
  };

  const transaction = dataSource.transaction.bind(dataSource);
  dataSource.transaction = (...args: unknown[]) =>
    traceClient(`${database.name ?? 'db'} transaction`, { ...base, 'db.operation.name': 'TRANSACTION' }, () =>
      transaction(...args),
    );
}

// ───────────────────────────── Redis (ioredis) ─────────────────────────────

/** The part of an ioredis Command that is read. */
interface RedisCommandLike {
  name: string;
  args: unknown[];
  promise: Promise<unknown>;
}

/** The part of an ioredis client that is wrapped. */
export interface RedisLike {
  options?: { host?: string; port?: number; db?: number };
  sendCommand(command: RedisCommandLike, ...rest: unknown[]): unknown;
}

/** The key a command works on, if it has one (`EVALSHA sha 1 key ...` → key). */
function redisKey(command: RedisCommandLike): string | undefined {
  const name = command.name.toLowerCase();
  const arg = name === 'eval' || name === 'evalsha' ? (Number(command.args[1]) > 0 ? command.args[2] : undefined) : command.args[0];
  return typeof arg === 'string' || Buffer.isBuffer(arg) ? String(arg) : undefined;
}

/**
 * Traces every command sent by `client` as a CLIENT span named after the
 * command (`HGETALL`, `EVALSHA`, `PUBLISH`), with the key but not the values.
 * Connections duplicated from it afterwards are not traced. Idempotent.
 */
export function instrumentRedis(client: RedisLike): void {
  const target = client as RedisLike & { [INSTRUMENTED]?: boolean };
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;

  const base: Attributes = {
    'db.system.name': 'redis',
    'db.namespace': String(client.options?.db ?? 0),
    ...(client.options?.host ? { 'server.address': client.options.host } : {}),
    ...(client.options?.port ? { 'server.port': client.options.port } : {}),
  };
  const sendCommand = client.sendCommand.bind(client);
  client.sendCommand = (command: RedisCommandLike, ...rest: unknown[]) => {
    if (!trace.getSpan(context.active())) return sendCommand(command, ...rest);
    const operation = command.name.toUpperCase();
    const key = redisKey(command);
    let result: unknown;
    let thrown: { error: unknown } | undefined;
    // traceClient calls the callback synchronously, so `result` is set before
    // it returns. The span ends when the command's reply (or error) arrives.
    void traceClient(
      operation,
      { ...base, 'db.operation.name': operation, ...(key ? { 'db.query.summary': `${operation} ${key}` } : {}) },
      () => {
        try {
          result = sendCommand(command, ...rest);
        } catch (error) {
          thrown = { error };
          throw error;
        }
        return command.promise;
      },
    ).catch(() => undefined); // the caller handles the error on its own promise
    if (thrown) throw thrown.error;
    return result;
  };
}
