/**
 * RedisModule: the connection to tracking-cache, from the validated `REDIS_URL`.
 *
 * - Connects at startup (so a wrong URL fails the boot, not the first request).
 * - `enableOfflineQueue: false` + `maxRetriesPerRequest: 1`: while Redis is
 *   down, commands fail at once instead of piling up, so `GET /tracking`
 *   answers 503 (spec 4.4) and the Kafka consumer retries / dead-letters.
 *   ioredis keeps reconnecting in the background.
 */
import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { instrumentRedis } from '@libs/observability';
import type { TrackingQueryEnvironment } from '../../../config/environment.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<TrackingQueryEnvironment, true>) => {
        const logger = new Logger('Redis');
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          commandTimeout: 2_000,
        });
        redis.on('error', (error: Error) => logger.warn(`tracking-cache: ${error.message}`));
        // Every command inside a request or Kafka message becomes a span (key only, no values).
        instrumentRedis(redis);
        await redis.connect();
        return redis;
      },
    },
    RedisShutdown,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
