# ADR-009: At-least-once delivery with idempotent consumers

- **Status:** Accepted
- **Features:** F2, F4, F5
- **Containers involved:** All Kafka consumers

## context and Problem

Events can be redelivered (consumer restarts, relay retries). Processing an event twice must never produce a wrong state, a duplicate notification or a status regression.

## Considered Alternatives

1. At-most-once (commit before processing): may lose events.
2. Exactly-once with Kafka transactions end to end.
3. At-least-once delivery with idempotent consumers.

## Decision

Consumers commit offsets after processing and are idempotent: Orders stores `processed_events`; GPS ignores processed sequences; Tracking Query uses version/sequence guards; Notifications uses `UNIQUE(order, type)`. Because the events of one order travel on different topics, consumers also tolerate any arrival order across topics: status events by version, assignment events for a terminal order are ignored, and locations by sequence (ADR-016).

## Trade-offs

### Positives (what we gain)

- No lost events and no duplicated effects.
- Works across database writes, which Kafka transactions do not cover.

### Negatives (risks / what we lose)

- Each consumer must implement its idempotency rule (more code and tests).
- Extra storage for processed ids. *Mitigation:* expire ids after the retention window.

## Final Justification

Exactly-once in Kafka only covers Kafka-to-Kafka flows; our consumers write to databases and external providers, so idempotency is required anyway.
