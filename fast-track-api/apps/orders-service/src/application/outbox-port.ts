export interface OutboxEvent {
  eventId: string;
  topic: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  producer: string;
  correlationId: string;
  aggregateVersion: number | null;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  attempts: number;
}

export interface EventEnvelope {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  aggregateId: string;
  aggregateVersion: number | null;
  payload: Record<string, unknown>;
}

export interface OutboxRepository {
  claimPending(limit: number, leaseOwner: string): Promise<OutboxEvent[]>;
  markPublished(eventId: string, leaseOwner: string): Promise<void>;
  markFailed(
    eventId: string,
    leaseOwner: string,
    error: string,
  ): Promise<void>;
}

export interface EventPublisher {
  publish(
    topic: string,
    key: string,
    event: EventEnvelope,
    headers: Record<string, string>,
  ): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
