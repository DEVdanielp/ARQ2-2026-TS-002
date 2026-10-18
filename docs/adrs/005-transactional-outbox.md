# ADR-005: Reliable event publication with a transactional outbox

- **Status:** Accepted
- **Features:** F1, F2, F4
- **Containers involved:** Orders, Profiles & Assignment, GPS Tracking Worker

## Context and Problem

A service that saves state and then publishes an event can fail between both steps, leaving the database and Kafka inconsistent (for example, an order DELIVERED with no `OrderDelivered` event, so the customer is never notified). Every step of the order fulfillment saga (ADR-016) depends on this guarantee.

## Considered Alternatives

1. Write to the database and publish to Kafka in sequence (dual write).
2. Change Data Capture with Debezium reading the database log.
3. Transactional outbox: write the event in an `outbox` table in the same transaction, and a relay publishes it.

## Decision

Use a transactional outbox in every service that publishes facts. A scheduled `OutboxRelay` reads pending rows, publishes them and marks them as sent.

## Trade-offs

### Positives (what we gain)

- No lost events: state and event commit atomically.
- Each saga step commits its local transaction and its event together, so the saga never stalls halfway (ADR-016).
- Uses only the service's own PostgreSQL; no extra infrastructure.

### Negatives (risks / what we lose)

- Events may be published twice if the relay fails after publishing. *Mitigation:* idempotent consumers (ADR-009).
- Small publication delay (polling interval). *Mitigation:* short interval (≈200 ms) or `LISTEN/NOTIFY`.
- Outbox table grows. *Mitigation:* periodic cleanup of sent rows.

## Final Justification

Dual writes break exactly the guarantee the case needs, and Debezium adds a connector cluster that the team would have to operate.
