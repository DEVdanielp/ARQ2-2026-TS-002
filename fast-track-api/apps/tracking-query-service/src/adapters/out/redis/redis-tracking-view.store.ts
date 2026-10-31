/**
 * TrackingViewStore over Redis (tracking-cache): one hash per order,
 * `tracking:view:{orderId}` (spec 3, storage ownership).
 *
 * Writes go through the Lua script (ADR-010); reads are one HGETALL, the
 * only Redis call on the hot path of `GET /tracking/{orderId}` (ADR-002).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AssignmentStatus, OrderStatus, StoredTrackingView } from '../../../domain/tracking-view.js';
import type { ViewChange } from '../../../domain/view-change.js';
import { TrackingCacheUnavailableError } from '../../../application/errors.js';
import { TrackingQuerySettings, TrackingViewStore } from '../../../application/ports.js';
import { APPLY_VIEW_CHANGE_LUA } from './apply-view-change.lua.js';
import { REDIS_CLIENT } from './redis.module.js';

export const viewKey = (orderId: string) => `tracking:view:${orderId}`;

type ScriptedRedis = Redis & {
  applyViewChange(key: string, change: string, ttlSeconds: number, now: string): Promise<number>;
};

@Injectable()
export class RedisTrackingViewStore extends TrackingViewStore {
  private readonly redis: ScriptedRedis;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    private readonly settings: TrackingQuerySettings,
  ) {
    super();
    // EVALSHA with automatic fallback to EVAL (ioredis caches the script's SHA).
    redis.defineCommand('applyViewChange', { numberOfKeys: 1, lua: APPLY_VIEW_CHANGE_LUA });
    this.redis = redis as ScriptedRedis;
  }

  async apply(change: ViewChange): Promise<boolean> {
    const result = await this.redis.applyViewChange(
      viewKey(change.orderId),
      JSON.stringify(toScriptArgument(change)),
      this.settings.terminalViewTtlSeconds,
      new Date().toISOString(),
    );
    return result === 1;
  }

  async get(orderId: string): Promise<StoredTrackingView | null> {
    let hash: Record<string, string>;
    try {
      hash = await this.redis.hgetall(viewKey(orderId));
    } catch (error) {
      throw new TrackingCacheUnavailableError(error);
    }
    return Object.keys(hash).length === 0 ? null : fromHash(orderId, hash);
  }
}

/**
 * The JSON the script receives. Optional fields are omitted (a JSON null would
 * decode to a truthy `cjson.null` in Lua). Coordinates and the assignment time
 * go as strings so Lua stores them exactly as sent.
 */
export function toScriptArgument(change: ViewChange): Record<string, unknown> {
  switch (change.kind) {
    case 'location':
      return {
        kind: change.kind,
        orderId: change.orderId,
        lat: String(change.location.lat),
        lng: String(change.location.lng),
        deviceTime: change.deviceTime,
        sequence: change.sequence,
      };
    case 'assigned':
    case 'unassigned':
    case 'failed':
      return withoutEmpty({ ...change, at: String(change.at) });
    default:
      return withoutEmpty({ ...change });
  }
}

function withoutEmpty(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

const toNumber = (value: string | undefined) => (value === undefined ? null : Number(value));

export function fromHash(orderId: string, hash: Record<string, string>): StoredTrackingView {
  const hasLocation = hash.lastLat !== undefined && hash.lastLng !== undefined;
  return {
    orderId: hash.orderId ?? orderId,
    customerId: hash.customerId ?? null,
    status: (hash.status as OrderStatus | undefined) ?? null,
    version: Number(hash.version ?? 0),
    driverId: hash.driverId ?? null,
    driverName: hash.driverName ?? null,
    assignmentStatus: (hash.assignmentStatus as AssignmentStatus | undefined) ?? 'PENDING',
    destination: hash.destination ? JSON.parse(hash.destination) : null,
    lastLocation: hasLocation ? { lat: Number(hash.lastLat), lng: Number(hash.lastLng) } : null,
    lastLocationDeviceTime: hash.lastLocationDeviceTime ?? null,
    lastSequence: toNumber(hash.lastSequence),
    nearbyReached: hash.nearbyReached === '1',
    // No event of spec 5.4 reaches Tracking Query with rejected intents yet.
    lastRejectedIntent: hash.lastRejectedIntent ? JSON.parse(hash.lastRejectedIntent) : null,
    updatedAt: hash.updatedAt ?? new Date(0).toISOString(),
    revision: Number(hash.revision ?? 0),
  };
}
