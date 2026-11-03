/**
 * One call at the top of every main.ts, before `NestFactory.create()`:
 *
 *   const { logger } = initObservability('notification-service');
 *   const app = await NestFactory.create(NotificationServiceModule, { logger });
 *   setupHttpObservability(app);
 *
 * The service name comes from `OTEL_SERVICE_NAME` (set per service in
 * docker-compose.yml) and falls back to the name passed here.
 */
import type { LoggerService } from '@nestjs/common';
import { createLogger } from './logger.js';
import { initMetrics } from './metrics.js';
import { startTracing } from './tracing.js';

export interface Observability {
  serviceName: string;
  /** Pass it to `NestFactory.create(..., { logger })`. */
  logger: LoggerService;
  tracing: boolean;
}

export function initObservability(defaultServiceName: string, env: NodeJS.ProcessEnv = process.env): Observability {
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaultServiceName;
  initMetrics(serviceName);
  const tracing = startTracing(serviceName, { env });
  return { serviceName, logger: createLogger(serviceName, env), tracing };
}
