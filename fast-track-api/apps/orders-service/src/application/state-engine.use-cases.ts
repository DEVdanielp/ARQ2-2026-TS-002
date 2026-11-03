/**
 * The state engine (F4): the only code that changes an order's status
 * (ADR-016). It runs from Kafka, one event at a time per order, and every use
 * case is idempotent by eventId (ADR-009): state, processed id and published
 * events commit in one transaction.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  applyTransition,
  assignDriver,
  decideIntent,
  unassignDriver,
  type Intent,
  type Order,
} from '../domain/order.js';
import { UnknownOrderError } from './errors.js';
import {
  intentRejected,
  orderTransitioned,
} from './events.js';
import { Clock, OrdersStore, type OrderSession } from './ports.js';

export type IntentOutcome = 'applied' | 'rejected' | 'duplicate';

export interface ApplyIntentCommand {
  /** The envelope's eventId, which is the intentId (spec 5.4). */
  intentId: string;
  eventType: string;
  orderId: string;
  intent: Intent;
  correlationId: string;
}

/** Consumes `orders.intents` (F4-S1 to F4-S8). */
@Injectable()
export class ApplyIntent {
  private readonly logger = new Logger(ApplyIntent.name);

  constructor(
    private readonly store: OrdersStore,
    private readonly clock: Clock,
  ) {}

  execute(command: ApplyIntentCommand): Promise<IntentOutcome> {
    return this.store.inSession(async (session) => {
      const { intentId, eventType, orderId, intent } = command;
      if (!(await session.markProcessed(intentId, eventType))) {
        return 'duplicate';
      }

      const now = this.clock.now();
      const order = await session.lockOrder(orderId);
      if (!order) {
        // The API checked that it exists, so only a hand-made message gets
        // here. Retrying cannot help: it is rejected like any other intent.
        await this.reject(session, command, 'Order does not exist.', now);
        return 'rejected';
      }

      const decision = decideIntent(order, intent);
      if (decision.kind === 'reject') {
        await this.reject(session, command, decision.reason, now, order);
        return 'rejected';
      }

      const changed = applyTransition(order, decision.status, intent, now);
      await session.updateOrder(changed);
      await session.publish(
        orderTransitioned(
          decision.eventType,
          changed,
          order.status,
          command.correlationId,
        ),
      );
      return 'applied';
    });
  }

  private async reject(
    session: OrderSession,
    command: ApplyIntentCommand,
    reason: string,
    now: Date,
    order?: Order,
  ): Promise<void> {
    const { intentId, orderId, intent, correlationId } = command;
    this.logger.warn({ msg: 'Intent rejected', intentId, orderId, reason });
    await session.recordRejectedIntent({
      intentId,
      orderId,
      intent,
      reason,
      rejectedAt: now,
    });
    if (order) {
      await session.publish(
        intentRejected(order, intentId, intent.type, reason, now, correlationId),
      );
    }
  }
}

export interface AssignmentCommand {
  eventId: string;
  eventType: string;
  orderId: string;
  driverId: string;
}

export type AssignmentOutcome = 'applied' | 'ignored' | 'duplicate';

/** Runs `change` on a locked order and stores the result, if there is one. */
async function changeDriver(
  store: OrdersStore,
  command: AssignmentCommand,
  change: (order: Order) => Order | null,
): Promise<AssignmentOutcome> {
  return store.inSession(async (session) => {
    if (!(await session.markProcessed(command.eventId, command.eventType))) {
      return 'duplicate';
    }
    const order = await session.lockOrder(command.orderId);
    if (!order) throw new UnknownOrderError(command.orderId);

    const changed = change(order);
    if (!changed) return 'ignored';
    await session.updateOrder(changed);
    return 'applied';
  });
}

/** `DriverAssigned`: saga step 3. Publishes nothing (spec 1); F4-S9 is `ignored`. */
@Injectable()
export class RecordDriverAssigned {
  constructor(
    private readonly store: OrdersStore,
    private readonly clock: Clock,
  ) {}

  execute(command: AssignmentCommand): Promise<AssignmentOutcome> {
    return changeDriver(this.store, command, (order) =>
      assignDriver(order, command.driverId, this.clock.now()),
    );
  }
}

/** `DriverUnassigned`: compensation of step 3 (F1-S6, F4-S8). */
@Injectable()
export class RecordDriverUnassigned {
  constructor(
    private readonly store: OrdersStore,
    private readonly clock: Clock,
  ) {}

  execute(command: AssignmentCommand): Promise<AssignmentOutcome> {
    return changeDriver(this.store, command, (order) =>
      unassignDriver(order, command.driverId, this.clock.now()),
    );
  }
}

/** Processed ids are kept for 7 days, the retention of the topics (ADR-009). */
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Removes what is no longer needed: expired keys and old processed ids. */
@Injectable()
export class PurgeExpired {
  constructor(
    private readonly store: OrdersStore,
    private readonly clock: Clock,
  ) {}

  execute(): Promise<void> {
    const now = this.clock.now();
    return this.store.purgeExpired(
      now,
      new Date(now.getTime() - PROCESSED_RETENTION_MS),
    );
  }
}
