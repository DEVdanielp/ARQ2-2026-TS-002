/**
 * ProcessGpsBatch: the core use case (F2-S3, S4, S5; F5-S1, S2).
 *
 * Triggered by every `GpsBatchReceived` from `gps.batches`. Kafka already
 * delivers the batches of one driver one at a time and in order (partition
 * key = driverId, ADR-001); inside the batch, the points are ordered here.
 *
 *   0. Before the transaction: ask the ETA provider, only for monitored
 *      orders within 3 km that were not asked in the last minute (ADR-013).
 *      The call is slow and external, so no database lock is held meanwhile.
 *   1. Lock the driver (one transaction per batch).
 *   2. Plan the batch (domain/batch-plan.ts): sort by sequence, drop sequences
 *      already stored, find the new last known location.
 *   3. Append the new points to the history (append-only, ADR-011).
 *   4. If the location moves forward, store it and, for every monitored order
 *      of the driver (ON_THE_WAY, F2-S5), enqueue `LocationUpdated` and run
 *      the NEARBY rule; `DriverNearDestination` is enqueued at most once per
 *      order (F5-S2).
 *   5. Commit: history, location, flags and events (outbox) together (ADR-005).
 *
 * Idempotent (ADR-009): a redelivered batch finds all its sequences stored,
 * so it stores nothing, moves nothing and publishes nothing.
 * The worker never changes the order status (spec 1: GPS points never change it).
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  createEnvelope,
  DRIVER_NEAR_DESTINATION,
  DRIVER_NEAR_DESTINATION_SCHEMA_VERSION,
  LOCATION_UPDATED,
  LOCATION_UPDATED_SCHEMA_VERSION,
  Topics,
  type DriverNearDestinationPayload,
  type GpsBatchReceivedPayload,
  type GpsPoint,
  type LocationUpdatedPayload,
} from '@libs/events';
import { latestPoint, planBatch } from '../domain/batch-plan.js';
import { detectProximity, distanceMeters, type ProximityDetection } from '../domain/proximity.js';
import type { MonitoredOrder } from '../domain/tracking.js';
import { DriverTrackingStore, EtaProvider, TrackingSettings, type BatchInfo, type DriverTrackingSession } from './ports.js';

export const PRODUCER_NAME = 'gps-tracking-worker';

export interface ProcessGpsBatchCommand {
  payload: GpsBatchReceivedPayload;
  correlationId: string;
}

export interface ProcessGpsBatchResult {
  /** Points appended to the history. */
  stored: number;
  /** Points ignored because their sequence was already processed (F2-S4). */
  duplicates: number;
  /** New points older than the last location: stored only (ADR-018). */
  late: number;
  /** Sequence of the last known location after the batch. */
  lastSequence: number | null;
  locationMoved: boolean;
  /** Orders that received a LocationUpdated. */
  locationUpdates: string[];
  /** Orders for which NEARBY fired in this batch. */
  nearby: string[];
}

@Injectable()
export class ProcessGpsBatch {
  private readonly logger = new Logger(ProcessGpsBatch.name);

  constructor(
    private readonly store: DriverTrackingStore,
    private readonly eta: EtaProvider,
    private readonly settings: TrackingSettings,
  ) {}

  async execute(command: ProcessGpsBatchCommand): Promise<ProcessGpsBatchResult> {
    const { payload, correlationId } = command;
    const { driverId } = payload;
    const batch: BatchInfo = { batchId: payload.batchId, receivedAt: payload.receivedAt };
    const now = new Date();

    const latest = latestPoint(payload.points);
    const etas = latest ? await this.lookUpEtas(driverId, latest, now, correlationId) : new Map<string, number | null>();

    return this.store.withDriver(driverId, async (session) => {
      const stored = await session.findStoredSequences(payload.points.map((point) => point.sequence));
      const plan = planBatch(payload.points, session.lastSequence, stored);

      if (plan.toStore.length > 0) await session.appendPoints(plan.toStore, batch);

      const result: ProcessGpsBatchResult = {
        stored: plan.toStore.length,
        duplicates: plan.duplicates,
        late: plan.late,
        lastSequence: plan.newLocation?.sequence ?? session.lastSequence,
        locationMoved: plan.newLocation !== null,
        locationUpdates: [],
        nearby: [],
      };
      if (!plan.newLocation) return result;

      const location = plan.newLocation;
      await session.moveLocation(location, batch);

      // The ETA was asked for the batch's latest point; it only applies if
      // that point really is the new location (not a late or duplicate one).
      const etaApplies = latest !== null && latest.sequence === location.sequence;

      for (const order of await session.lockMonitoredOrders()) {
        await session.publish(this.locationUpdated(order, location, correlationId));
        result.locationUpdates.push(order.orderId);

        const eta = etaApplies ? etas.get(order.orderId) : undefined;
        if (eta !== undefined) await session.recordEtaCheck(order.orderId, now);

        if (order.nearbyReachedAt) continue;
        const detection = detectProximity(
          order.destination,
          plan.advancing,
          { distanceMeters: this.settings.nearbyDistanceMeters, etaSeconds: this.settings.nearbyEtaSeconds },
          eta ?? null,
        );
        if (detection && (await this.markNearby(session, order, detection, now, correlationId))) {
          result.nearby.push(order.orderId);
        }
      }
      return result;
    });
  }

  /**
   * ADR-013: ETA only within `etaLookupRadiusMeters`, at most once per
   * `etaMinIntervalSeconds` per order, and never for orders already NEARBY or
   * already inside the distance threshold (distance decides there). A failing
   * provider yields null: distance-only fallback, and the throttle still
   * applies so a broken provider is not hammered.
   *
   * @returns orderId -> ETA in seconds (or null if the call failed), only for orders that were asked.
   */
  private async lookUpEtas(
    driverId: string,
    latest: GpsPoint,
    now: Date,
    correlationId: string,
  ): Promise<Map<string, number | null>> {
    const etas = new Map<string, number | null>();
    if (!this.eta.enabled) return etas;

    for (const order of await this.store.findMonitoredOrders(driverId)) {
      if (order.nearbyReachedAt) continue;
      const distance = distanceMeters(latest, order.destination);
      if (distance >= this.settings.etaLookupRadiusMeters || distance < this.settings.nearbyDistanceMeters) continue;
      if (order.etaCheckedAt && now.getTime() - order.etaCheckedAt.getTime() < this.settings.etaMinIntervalSeconds * 1000) {
        continue;
      }
      try {
        etas.set(order.orderId, await this.eta.estimateSeconds(latest, order.destination));
      } catch (error) {
        etas.set(order.orderId, null);
        this.logger.warn({
          msg: 'ETA provider failed; using distance only',
          orderId: order.orderId,
          driverId,
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }
    return etas;
  }

  private async markNearby(
    session: DriverTrackingSession,
    order: MonitoredOrder,
    detection: ProximityDetection<GpsPoint>,
    now: Date,
    correlationId: string,
  ): Promise<boolean> {
    // The flag is set with "WHERE not set yet": only one batch can ever win it.
    if (!(await session.markNearby(order.orderId, detection.trigger, now))) return false;

    const payload: DriverNearDestinationPayload = {
      orderId: order.orderId,
      driverId: order.driverId,
      trigger: detection.trigger,
      distanceMeters: Math.round(detection.distanceMeters),
      etaSeconds: detection.etaSeconds === null ? null : Math.round(detection.etaSeconds),
      location: { lat: detection.point.lat, lng: detection.point.lng },
      detectedAt: now.toISOString(),
    };
    await session.publish({
      topic: Topics.TRACKING_PROXIMITY,
      key: order.orderId,
      envelope: createEnvelope({
        eventType: DRIVER_NEAR_DESTINATION,
        schemaVersion: DRIVER_NEAR_DESTINATION_SCHEMA_VERSION,
        producer: PRODUCER_NAME,
        correlationId,
        aggregateId: order.orderId,
        aggregateVersion: null,
        payload,
      }),
    });
    this.logger.log({ msg: 'Driver near destination', ...payload, correlationId });
    return true;
  }

  private locationUpdated(order: MonitoredOrder, point: GpsPoint, correlationId: string) {
    const payload: LocationUpdatedPayload = {
      orderId: order.orderId,
      driverId: order.driverId,
      location: { lat: point.lat, lng: point.lng },
      deviceTime: point.deviceTime,
      sequence: point.sequence,
    };
    return {
      topic: Topics.TRACKING_LOCATIONS,
      key: order.orderId,
      envelope: createEnvelope({
        eventType: LOCATION_UPDATED,
        schemaVersion: LOCATION_UPDATED_SCHEMA_VERSION,
        producer: PRODUCER_NAME,
        correlationId,
        aggregateId: order.orderId,
        aggregateVersion: null,
        payload,
      }),
    } as const;
  }
}
