import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseIntentMessage } from './intent-message.js';
import {
  STATE_ENGINE_REPOSITORY,
  type ProcessIntentResult,
  type StateEngineRepository,
} from './state-engine.port.js';
import type { IntentProcessor } from './intent-processor.port.js';

@Injectable()
export class IntentProcessorService implements IntentProcessor {
  private readonly logger = new Logger(IntentProcessorService.name);

  constructor(
    @Inject(STATE_ENGINE_REPOSITORY)
    private readonly stateEngine: StateEngineRepository,
  ) {}

  async process(
    value: Buffer | null,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<ProcessIntentResult> {
    const message = parseIntentMessage(value, topic, partition, offset);
    const result = await this.stateEngine.processIntent(message);
    if (result.kind === 'rejected') {
      this.logger.warn(
        `Intent ${message.event.eventId} rejected: ${result.reason}`,
      );
    } else if (result.kind === 'applied') {
      this.logger.log(
        `Intent ${message.event.eventId} applied; order ${message.event.aggregateId} is ${result.status} at version ${result.version}.`,
      );
    }
    return result;
  }
}
