/**
 * Ports of the GPS Ingestion API (ADR-014).
 *
 * The service is deliberately minimal (ADR-014: "keep small services minimal"):
 * one use case and one outbound port. The port is an abstract class, not an
 * interface, because Nest needs a runtime token to inject its implementation.
 */
import type { EventEnvelope, GpsBatchReceivedPayload } from '@libs/events';

/** Publishes a `GpsBatchReceived` to the event bus, keyed by driver. */
export abstract class GpsBatchPublisher {
  /**
   * Resolves once the event bus confirmed the write.
   *
   * @throws {EventBusUnavailableError} if the write was not confirmed in time.
   */
  abstract publish(envelope: EventEnvelope<GpsBatchReceivedPayload>): Promise<void>;
}

/**
 * The event bus did not confirm the batch. Mapped to HTTP 503: the driver app
 * keeps the batch and retries (spec 4.3). A retry may duplicate points that
 * were in fact written; the worker ignores them by sequence (ADR-001, ADR-009).
 */
export class EventBusUnavailableError extends Error {
  constructor(reason: string) {
    super(`Event bus unavailable: ${reason}`);
    this.name = 'EventBusUnavailableError';
  }
}
