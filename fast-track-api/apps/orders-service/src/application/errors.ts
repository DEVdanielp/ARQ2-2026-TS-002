/**
 * Errors raised by use cases. Adapters translate them: the HTTP adapter maps
 * them to status codes, the Kafka adapter lets them trigger a retry.
 */

/** The order does not exist. Mapped to 404. */
export class NotFoundError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NotFoundError';
  }
}

/** The role or ownership does not allow the action. Mapped to 403. */
export class ForbiddenError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ForbiddenError';
  }
}

/** Codes of the 409 conflicts of spec 4.2, also used as the problem `type`. */
export type ConflictCode = 'order-terminal' | 'idempotency-key-reused';

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

/** Kafka or the database cannot be reached right now. Mapped to 503. */
export class ServiceUnavailableError extends Error {
  constructor(dependency: 'Kafka' | 'The database') {
    super(`${dependency} is temporarily unavailable; try again.`);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * An assignment event arrived for an order this service never created. Only
 * a wrong event can cause this: throwing retries it and then parks it in
 * `assignment.events.dlq`, where it stays visible.
 */
export class UnknownOrderError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} does not exist in orders-db`);
    this.name = 'UnknownOrderError';
  }
}
