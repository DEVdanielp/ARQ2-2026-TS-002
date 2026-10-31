/**
 * GetOrderRoute: `GET /tracking/{orderId}/route?from&to` (spec 4.4), route
 * audit for operations, served from `query-archive-db` (never from Redis).
 * The role check (`OPERATIONS`) is done by the HTTP adapter's guard.
 *
 * `from` and `to` are optional ISO-8601 instants filtering by device time;
 * without them the whole route is returned.
 */
import { Injectable } from '@nestjs/common';
import { InvalidRouteRangeError, OrderNotFoundError } from './errors.js';
import { TrackingArchive, type OrderRoute, type TimeRange } from './ports.js';

@Injectable()
export class GetOrderRoute {
  constructor(private readonly archive: TrackingArchive) {}

  /**
   * @throws {InvalidRouteRangeError} invalid date or `from` after `to` (400).
   * @throws {OrderNotFoundError} the archive knows nothing about the order (404).
   */
  async execute(orderId: string, from?: string, to?: string): Promise<OrderRoute> {
    const range: TimeRange = { from: parseInstant('from', from), to: parseInstant('to', to) };
    if (range.from && range.to && range.from > range.to) {
      throw new InvalidRouteRangeError('"from" must not be after "to"');
    }

    const route = await this.archive.findRoute(orderId, range);
    if (!route) throw new OrderNotFoundError(orderId);
    return route;
  }
}

/** ISO-8601 date-time with a time zone, like every time in the API (spec 2). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(name: string, value: string | undefined): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const time = Date.parse(value);
  if (!ISO_INSTANT.test(value) || Number.isNaN(time)) {
    throw new InvalidRouteRangeError(`"${name}" must be an ISO-8601 date-time with time zone, e.g. 2026-10-18T15:20:00Z`);
  }
  return new Date(time);
}
