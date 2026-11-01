/**
 * Errors raised by use cases. Adapters translate them: the HTTP adapter maps
 * them to status codes (404, 409), the Kafka adapter lets them trigger a retry.
 */

/** The resource does not exist (or is not visible to the caller). Mapped to 404. */
export class NotFoundError extends Error {
  constructor(
    readonly resource: 'customer' | 'driver' | 'assignment',
    detail: string,
  ) {
    super(detail);
    this.name = 'NotFoundError';
  }
}

/** Codes of the 409 conflicts of spec 4.1, also used as the problem `type`. */
export type ConflictCode = 'orders-on-the-way' | 'capacity-below-active-orders';

/** The request conflicts with the current state. Mapped to 409. */
export class ConflictError extends Error {
  constructor(
    readonly code: ConflictCode,
    readonly title: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'ConflictError';
  }
}

/** A value the DTO validation cannot catch alone. Mapped to 400. */
export class InvalidInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * An order event arrived for an order whose `OrderCreated` was never
 * processed. Events of one order share the `orders.events` partition, so this
 * only happens if `OrderCreated` went to the DLQ; throwing makes the consumer
 * retry and then park this event in `orders.events.dlq` too, where it stays
 * visible.
 */
export class UnknownOrderError extends Error {
  constructor(readonly orderId: string) {
    super(
      `Order ${orderId} is unknown to Profiles (OrderCreated not processed)`,
    );
    this.name = 'UnknownOrderError';
  }
}
