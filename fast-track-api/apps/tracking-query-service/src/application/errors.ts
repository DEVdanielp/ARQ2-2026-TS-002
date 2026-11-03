/**
 * Errors the use cases throw. The HTTP adapter maps them to status codes
 * (spec 4.4); they carry no HTTP knowledge themselves (ADR-014).
 */

/** No view in Redis nor in the archive. -> 404 */
export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotFoundError';
  }
}

/** The caller is neither the owner nor operations. -> 403 */
export class OrderAccessDeniedError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} does not belong to the caller`);
    this.name = 'OrderAccessDeniedError';
  }
}

/** `from`/`to` are not ISO dates, or `from` is after `to`. -> 400 */
export class InvalidRouteRangeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidRouteRangeError';
  }
}

/** Redis (tracking-cache) cannot be reached. -> 503 */
export class TrackingCacheUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Tracking cache unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TrackingCacheUnavailableError';
  }
}
