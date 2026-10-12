# ADR-002: Per-order read model in Redis with status-based retention (CQRS)

- **Status:** Accepted
- **Features:** F3
- **Containers involved:** Tracking Query Service, tracking-cache, query-archive-db

## Context and Problem

Customers poll every 3 seconds and each request runs heavy JOINs in PostgreSQL (an internal DDoS). The status query must absorb high read demand without touching relational databases. Active orders must always be in the cache; terminal orders only for a limited time.

## Considered Alternatives

1. Cache-aside of the current JOIN query in Redis with a fixed TTL.
2. PostgreSQL read replicas with materialized views.
3. CQRS projection: one view per order in Redis, built from events, with no TTL while active and 24 h after a terminal state.

## Decision

Tracking Query builds one view per order from events with version-guarded writes. Active orders (`CREATED`, `ON_THE_WAY`) never expire. Terminal orders (`DELIVERED`, `CANCELLED`) expire 24 hours after the terminal event and are then read from `query-archive-db`.

## Trade-offs

### Positives (what we gain)

- One key read per order: no JOINs and no relational database on the hot path.
- Version guards make regressions in the view impossible.
- The archive keeps old orders queryable without loading Redis.

### Negatives (risks / what we lose)

- Eventual consistency: the view can lag the event by milliseconds.
- Redis memory cost. *Mitigation:* bounded to active orders plus 24 h of terminal ones.
- If Redis loses data the view must be rebuilt. *Mitigation:* AOF persistence and event replay from Kafka.

## Final Justification

A fixed TTL could expire an active order and send its reads back to PostgreSQL, and read replicas still execute JOINs. Twenty-four hours covers the period in which customers still check a finished order; after that, demand is low enough for the archive.
