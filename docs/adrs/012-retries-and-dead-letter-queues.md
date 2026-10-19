# ADR-012: Retries with backoff and dead-letter queues

- **Status:** Accepted
- **Features:** F5 (and all consumers)
- **Containers involved:** Notification Service, all consumers

## Context and Problem

External providers (push, email, ETA) fail transiently. A blocking retry inside a consumer stops its partition, delaying every other event for that key.

## Considered Alternatives

1. Retry in place, blocking the partition.
2. Drop the event after a failure.
3. Retry topic with backoff and a dead-letter queue (DLQ) after N attempts.

## Decision

Failed notifications are published to `notifications.retry` with the attempt count; `RetryConsumer` processes them after an exponential backoff. After the maximum attempts, the event goes to a DLQ per topic for manual review.

## Trade-offs

### Positives (what we gain)

- Provider failures never block ingestion or transitions.
- Failed events remain visible and replayable.

### Negatives (risks / what we lose)

- Retries break strict ordering for that notification. Acceptable: notification order is not a business rule.
- DLQs need monitoring. *Mitigation:* alert when a DLQ is not empty.

## Final Justification

It keeps the main flows unblocked, which is an explicit requirement for notifications.
