/**
 * ProjectTrackingEvent (`ProjectEventHandler` in ADR-004): applies one event
 * to the read model and tells the SSE streams.
 *
 * Steps, all idempotent so a redelivered event is harmless (ADR-009):
 *
 * 1. `LocationUpdated` -> append the point to the route archive (route audit,
 *    spec 4.4). Stored even if it does not move the view (late or after delivery).
 * 2. Apply the change to the Redis view with its guards (ADR-010).
 * 3. Order / assignment / NEARBY changes -> copy the view to the archive, so it
 *    can still be served after the 24 h Redis expiry (F3-S5). Done even when
 *    step 2 was a no-op: if a previous attempt died between 2 and 3, the retry
 *    still writes the snapshot. Location changes do not snapshot (one write per
 *    GPS batch would load PostgreSQL for nothing); the terminal status
 *    snapshot already carries the last location.
 * 4. If the view changed, publish its order id on `tracking:changes` (ADR-004).
 */
import { Injectable } from '@nestjs/common';
import { isVisible } from '../domain/tracking-view.js';
import type { ViewChange } from '../domain/view-change.js';
import { TrackingArchive, TrackingViewStore, ViewChangeBus } from './ports.js';

@Injectable()
export class ProjectTrackingEvent {
  constructor(
    private readonly views: TrackingViewStore,
    private readonly archive: TrackingArchive,
    private readonly changes: ViewChangeBus,
  ) {}

  /** @returns true if the view changed. */
  async execute(change: ViewChange): Promise<boolean> {
    if (change.kind === 'location') {
      await this.archive.appendRoutePoint({
        orderId: change.orderId,
        driverId: change.driverId,
        location: change.location,
        deviceTime: change.deviceTime,
        sequence: change.sequence,
      });
    }

    const changed = await this.views.apply(change);

    if (change.kind !== 'location') {
      const view = await this.views.get(change.orderId);
      if (isVisible(view)) await this.archive.saveSnapshot(view);
    }

    if (changed) await this.changes.publish(change.orderId);
    return changed;
  }
}
