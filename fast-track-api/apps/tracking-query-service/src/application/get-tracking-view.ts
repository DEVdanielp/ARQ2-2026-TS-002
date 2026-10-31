/**
 * GetTrackingView: `GET /tracking/{orderId}` (spec 4.4, F3-S1, F3-S5).
 *
 * Reads Redis first: an active order is always there (no expiry while active,
 * ADR-002), so the hot path never touches PostgreSQL (F3-S1). Only when the
 * key is missing (terminal order older than 24 h) is the archive asked.
 * Redis down -> TrackingCacheUnavailableError (503): the archive is not a
 * substitute for live data.
 */
import { Injectable } from '@nestjs/common';
import { canView, isVisible, toTrackingView, type TrackingView, type Viewer } from '../domain/tracking-view.js';
import { OrderAccessDeniedError, OrderNotFoundError } from './errors.js';
import { Clock, TrackingArchive, TrackingViewStore } from './ports.js';

export interface TrackingViewResult {
  view: TrackingView;
  /** View revision: the SSE event id. */
  revision: number;
}

@Injectable()
export class GetTrackingView {
  constructor(
    private readonly views: TrackingViewStore,
    private readonly archive: TrackingArchive,
    private readonly clock: Clock,
  ) {}

  /**
   * @throws {OrderNotFoundError} the order is unknown (404).
   * @throws {OrderAccessDeniedError} the caller is not the owner nor operations (403).
   * @throws {TrackingCacheUnavailableError} Redis is down (503).
   */
  async execute(orderId: string, viewer: Viewer): Promise<TrackingViewResult> {
    const cached = await this.views.get(orderId);
    const stored = isVisible(cached) ? cached : await this.archive.findSnapshot(orderId);

    if (!isVisible(stored)) throw new OrderNotFoundError(orderId);
    if (!canView(viewer, stored)) throw new OrderAccessDeniedError(orderId);

    return { view: toTrackingView(stored, this.clock.now()), revision: stored.revision };
  }
}
