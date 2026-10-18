# ADR-011: Storage for the append-only GPS history

- **Status:** Accepted
- **Features:** F2
- **Containers involved:** GPS Tracking Worker, tracking-db

## Context and Problem

Every GPS point must be kept for auditing, never modified. Volume grows continuously with active drivers.

## Considered Alternatives

1. Keep the history only in Kafka (long retention).
2. PostgreSQL table partitioned by month, insert-only.
3. Time-series database (TimescaleDB) or object storage (S3 + Parquet).

## Decision

PostgreSQL with monthly partitions, insert-only, owned by the GPS Tracking Worker. Old partitions can be detached and archived.

## Trade-offs

### Positives (what we gain)

- Same technology as the rest of the services; queries by driver and time are simple.
- Partitions make retention and archiving cheap.

### Negatives (risks / what we lose)

- Not as compact as a time-series database. *Mitigation:* migrate to TimescaleDB (a PostgreSQL extension) if volume requires it.
- Kafka retention is not an audit store (compaction and retention can delete data).

## Final Justification

It meets the audit requirement with the team's existing stack and leaves a direct migration path if volume grows.
