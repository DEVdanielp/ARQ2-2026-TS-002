/**
 * WatchTrackingView: the logic behind `GET /tracking/{orderId}/stream` (SSE,
 * spec 4.4, ADR-004), independent of HTTP.
 *
 * - Subscribes to the order's changes BEFORE the first read, so a change that
 *   lands between both is not lost.
 * - Sends the current view first, unless the client reconnected with a
 *   `Last-Event-ID` that is already the current revision (spec: "sends the
 *   current view if its version is higher").
 * - On every change notification it re-reads the view and sends it if its
 *   revision is higher than the last one sent. Reads are chained, so two quick
 *   notifications can never send an older view after a newer one.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Viewer } from '../domain/tracking-view.js';
import { GetTrackingView, type TrackingViewResult } from './get-tracking-view.js';
import { ViewChangeBus } from './ports.js';

export interface WatchOptions {
  orderId: string;
  viewer: Viewer;
  /** Revision from the `Last-Event-ID` header, if the client is reconnecting. */
  lastEventId: number | null;
  send: (event: TrackingViewResult) => void;
}

@Injectable()
export class WatchTrackingView {
  private readonly logger = new Logger(WatchTrackingView.name);

  constructor(
    private readonly getView: GetTrackingView,
    private readonly changes: ViewChangeBus,
  ) {}

  /**
   * Starts watching. Access errors are thrown here, before anything is sent,
   * so the HTTP adapter can still answer 403/404/503.
   *
   * @returns the function that stops watching (call it when the client leaves).
   */
  async start({ orderId, viewer, lastEventId, send }: WatchOptions): Promise<() => void> {
    let lastSent = lastEventId ?? -1;
    const deliver = (event: TrackingViewResult) => {
      if (event.revision <= lastSent) return;
      lastSent = event.revision;
      send(event);
    };

    let pending = Promise.resolve();
    const unsubscribe = this.changes.subscribe(orderId, () => {
      pending = pending
        .then(() => this.getView.execute(orderId, viewer))
        .then(deliver)
        .catch((error: unknown) => {
          this.logger.warn({ msg: 'Could not refresh tracking view for SSE', orderId, error: String(error) });
        });
    });

    try {
      deliver(await this.getView.execute(orderId, viewer));
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }
}
