/**
 * Errors raised by use cases. Adapters translate them: the HTTP adapter maps
 * them to status codes, the Kafka adapter lets them trigger a retry.
 */

/**
 * We do not know the customer of this order yet: its OrderCreated has not
 * been processed. Events of one order travel on different topics, so this can
 * happen briefly; throwing makes the consumer retry (200 ms, 1 s, 5 s), which
 * usually gives OrderCreated time to arrive.
 */
export class RecipientNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`No customer known for order ${orderId} (OrderCreated not processed yet)`);
    this.name = 'RecipientNotFoundError';
  }
}

/** The order does not exist for this caller (unknown, or not theirs). Mapped to 404. */
export class OrderNotVisibleError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotVisibleError';
  }
}
