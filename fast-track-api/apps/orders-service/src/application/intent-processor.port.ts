import type { ProcessIntentResult } from './state-engine.port.js';

export interface IntentProcessor {
  process(
    value: Buffer | null,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<ProcessIntentResult>;
}

export const INTENT_PROCESSOR = Symbol('INTENT_PROCESSOR');
