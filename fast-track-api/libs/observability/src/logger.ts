/**
 * The Nest logger every service uses.
 *
 * - `LOG_FORMAT=json` (set in docker-compose.yml): one JSON object per line,
 *   which Promtail ships to Loki. Each line gets `service`, and `traceId` /
 *   `spanId` when it was written inside a span, so Grafana can jump from a log
 *   line to its trace and back. Messages that are objects (the convention in
 *   this repo: `logger.log({ msg, correlationId, ... })`) stay nested under
 *   `message`, so Grafana's `"correlationId":"..."` link keeps working.
 * - Anything else (a host run): Nest's usual coloured text.
 * - `LOG_LEVEL`: `error`, `warn`, `info` (default), `debug` or `verbose`.
 */
import { ConsoleLogger, type ConsoleLoggerOptions, type LoggerService, type LogLevel } from '@nestjs/common';
import { activeTraceIds } from './tracing.js';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

const LEVEL_INDEX: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  log: 3,
  debug: 4,
  verbose: 5,
  trace: 5,
};

/** `info` → fatal, error, warn, log. Unknown values fall back to `info`. */
export function logLevelsFor(level: string | undefined): LogLevel[] {
  const index = LEVEL_INDEX[(level ?? 'info').trim().toLowerCase()] ?? LEVEL_INDEX.info;
  return LEVELS.slice(0, index + 1);
}

/** ConsoleLogger whose JSON lines also carry the service and the active trace. */
export class FastTrackLogger extends ConsoleLogger {
  constructor(
    private readonly serviceName: string,
    options: ConsoleLoggerOptions,
  ) {
    super(options);
  }

  protected override getJsonLogObject(
    message: unknown,
    options: { context: string; logLevel: LogLevel; errorStack?: unknown; params?: Record<string, any>; error?: Error },
  ) {
    const logObject = super.getJsonLogObject(message, options);
    logObject.service = this.serviceName;
    const ids = activeTraceIds();
    if (ids) {
      logObject.traceId = ids.traceId;
      logObject.spanId = ids.spanId;
    }
    return logObject;
  }
}

export function createLogger(serviceName: string, env: NodeJS.ProcessEnv = process.env): LoggerService {
  return new FastTrackLogger(serviceName, {
    json: env.LOG_FORMAT?.trim().toLowerCase() === 'json',
    logLevels: logLevelsFor(env.LOG_LEVEL),
  });
}
