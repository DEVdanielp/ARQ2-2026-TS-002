# ADR-017: Delayed notification retries scheduled through the outbox

- **Status:** Accepted
- **Features:** F5
- **Containers involved:** Notification Service, Kafka

## Context and Problem

ADR-012 retries failed notifications through `notifications.retry` with a backoff of 1, 5 and 15 minutes (`notBefore` in `NotificationRetry`). Kafka has no delayed delivery: a message is delivered as soon as it is published. If the `RetryConsumer` waited inside its handler until `notBefore`, it would block its partition, and after `max.poll.interval.ms` (5 minutes by default) Kafka would consider the consumer dead, rebalance the group and redeliver the same message, in a loop. Recording the retry in the database and publishing the event is also a dual write, which ADR-005 forbids.

## Considered Alternatives

1. Sleep in the consumer until `notBefore`.
2. Pause the partition, seek back to the message and resume it when `notBefore` is reached (requires extending `@libs/kafka`).
3. Store the retry in the database and let a scheduled job resend it, using the topic only as a log.
4. Write the `NotificationRetry` to the transactional outbox with a `publish_after` column; the relay publishes it only when it is due.

## Decision

Option 4. The outbox table gets an optional `publish_after` column; the relay publishes a row only when `publish_after` is null or in the past. When a send fails, the Notification Service updates `notification_log` (`RETRYING`, `attempts`, `last_error`) and inserts the `NotificationRetry` with `publish_after = notBefore` in the same transaction. The `RetryConsumer` receives the message when it is due and retries at once. After the 3rd retry fails, the log entry becomes `DEAD_LETTERED` and the message is written, again through the outbox, to `notifications.retry.dlq`.

## Trade-offs

### Positives (what we gain)

- No consumer ever waits, so partitions are never blocked and no rebalance is triggered.
- The log update and the scheduled retry commit atomically (ADR-005).
- `notifications.retry` is used as the spec describes, with no extra infrastructure.
- `publish_after` is optional, so the outbox stays the same for every other service.

### Negatives (risks / what we lose)

- Retries depend on the outbox relay running. *Mitigation:* the relay polls continuously, and pending retries survive restarts because they are database rows.
- Retry timing is approximate (backoff plus the relay's polling interval). Acceptable: notification timing is not a business rule.
- The Notification Service cannot finish its retry flow until `@libs/outbox` exists. *Mitigation:* the other notification features do not depend on it.

## Final Justification

The outbox is required by ADR-005 anyway, and a nullable `publish_after` turns it into a scheduler at almost no cost. The other options either break the consumer (1), add the most complex code to the shared Kafka library (2), or leave a dual write and reduce the topic to a log (3).
