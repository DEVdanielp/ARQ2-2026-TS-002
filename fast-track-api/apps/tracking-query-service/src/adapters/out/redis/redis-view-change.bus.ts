/**
 * ViewChangeBus over Redis Pub/Sub, channel `tracking:changes` (spec 3,
 * ADR-004). The message is the order id.
 *
 * A subscribed Redis connection cannot run other commands, so this adapter
 * opens its own connection and subscribes ONCE per instance; it then fans the
 * messages out to the local SSE streams of that order. ioredis re-subscribes
 * by itself after a reconnection.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ViewChangeBus } from '../../../application/ports.js';
import { REDIS_CLIENT } from './redis.module.js';

export const TRACKING_CHANGES_CHANNEL = 'tracking:changes';

@Injectable()
export class RedisViewChangeBus extends ViewChangeBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisViewChangeBus.name);
  private readonly listeners = new Map<string, Set<() => void>>();
  private subscriber?: Redis;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate({ lazyConnect: false, enableOfflineQueue: true });
    this.subscriber.on('message', (_channel: string, orderId: string) => this.dispatch(orderId));
    this.subscriber.on('error', (error: Error) => this.logger.warn(`Pub/Sub connection: ${error.message}`));
    await this.subscriber.subscribe(TRACKING_CHANGES_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  async publish(orderId: string): Promise<void> {
    await this.redis.publish(TRACKING_CHANGES_CHANNEL, orderId);
  }

  subscribe(orderId: string, listener: () => void): () => void {
    let set = this.listeners.get(orderId);
    if (!set) {
      set = new Set();
      this.listeners.set(orderId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orderId);
    };
  }

  private dispatch(orderId: string): void {
    for (const listener of this.listeners.get(orderId) ?? []) listener();
  }
}
