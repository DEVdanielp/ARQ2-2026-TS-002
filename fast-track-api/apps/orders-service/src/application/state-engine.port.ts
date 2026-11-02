import type { EventEnvelope } from './outbox-port.js';
import type { OrderIntent } from './intent-state-engine.js';

export interface IntentMessage {
  event: EventEnvelope;
  intent: OrderIntent & { intentId: string; requestedAt: string };
  topic: string;
  partition: number;
  offset: string;
}

export type ProcessIntentResult =
  | { kind: 'applied'; status: string; version: number }
  | { kind: 'rejected'; reason: string; status: string }
  | { kind: 'duplicate' };

export interface StateEngineRepository {
  processIntent(message: IntentMessage): Promise<ProcessIntentResult>;
}

export const STATE_ENGINE_REPOSITORY = Symbol('STATE_ENGINE_REPOSITORY');
