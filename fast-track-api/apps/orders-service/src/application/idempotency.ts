/**
 * `Idempotency-Key` (spec 2): a repeated key within 24 h returns the original
 * response; the same key with a different body is a conflict (spec 4.2).
 */
import { createHash, randomUUID } from 'node:crypto';
import { ConflictError } from './errors.js';
import type { IdempotencyScope, OrderSession } from './ports.js';

const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface IdempotentRequest {
  ownerId: string;
  scope: string;
  /** The header value; undefined when the client did not send one. */
  key?: string;
  /** Everything that makes two requests "the same", with fixed key order. */
  fingerprint: unknown;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

/**
 * Runs `work` once per key, inside the caller's session.
 *
 * The key is locked first, so a parallel request with the same key waits for
 * this one and then gets its response.
 */
export async function runIdempotent<T>(
  session: OrderSession,
  request: IdempotentRequest,
  now: Date,
  work: () => Promise<IdempotentResult<T>>,
): Promise<IdempotentResult<T>> {
  if (!request.key) return work();

  const target: IdempotencyScope = {
    ownerId: request.ownerId,
    scope: request.scope,
    key: request.key,
  };
  const requestHash = createHash('sha256')
    .update(JSON.stringify(request.fingerprint))
    .digest('hex');

  await session.lockIdempotencyKey(target);
  const stored = await session.findResponse(target, now);
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new ConflictError(
        'idempotency-key-reused',
        'Idempotency key reused',
        `Idempotency-Key ${request.key} was already used with a different body.`,
      );
    }
    return { status: stored.status, body: stored.body as T };
  }

  const result = await work();
  await session.saveResponse(
    target,
    { requestHash, status: result.status, body: result.body },
    new Date(now.getTime() + KEY_LIFETIME_MS),
  );
  return result;
}

/**
 * The intent id. With a key it derives from it: if the process dies after
 * Kafka confirmed but before the key was stored, the client's retry publishes
 * the SAME id and the state engine drops the duplicate (F4-S7).
 */
export function intentIdFor(
  ownerId: string,
  scope: string,
  key: string | undefined,
): string {
  if (!key) return randomUUID();
  const hash = createHash('sha256')
    .update(`${ownerId}:${scope}:${key}`)
    .digest('hex');
  // UUID v4 layout: version nibble 4, variant nibble 8–b (spec 2, IDs).
  const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}
