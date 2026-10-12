# ADR-006: Order intents enter over REST and are queued per order in Kafka

- **Status:** Proposed
- **Features:** F4
- **Containers involved:** Driver App, Customer App, Operations Console, API Gateway, Orders Service

## Context and Problem

Feature 4 requires state transitions driven exclusively by events. Pickup and delivery confirmations come from the driver app and cancellations from the customer or operations, all outside the cluster. Requests for the same order can arrive concurrently.

## Considered Alternatives

1. Apps publish intents directly to Kafka.
2. REST endpoint applies the transition synchronously.
3. REST endpoint publishes the intent to an Orders-owned topic keyed by `orderId`, returns `202`, and the state engine consumes it in order.

## Decision

Apps call `POST /orders/{id}/intents` through the gateway. Orders publishes `PickupConfirmed`, `DeliveryConfirmed` or `CancellationRequested` to `orders.intents` (key = `orderId`) and returns `202 Accepted`. `IntentConsumer` applies transitions one at a time per order.

## Trade-offs

### Positives (what we gain)

- Transitions are event-driven, satisfying F4.
- Intents for the same order are serialized by the partition: no concurrent transitions.
- Kafka stays internal; authentication and rate limiting remain in the gateway.

### Negatives (risks / what we lose)

- The app does not get the final result in the response. *Mitigation:* the result arrives through the SSE view; rejected intents are reported in the view.
- One more hop (latency of milliseconds).

## Final Justification

Exposing Kafka to mobile apps is insecure and impractical, and synchronous transitions break F4. Queuing intents per order keeps the gateway in front and the state engine event-driven.
