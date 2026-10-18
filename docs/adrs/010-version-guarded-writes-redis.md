# ADR-010: Atomic version-guarded writes in Redis

- **Status:** Accepted
- **Features:** F3
- **Containers involved:** Tracking Query Service, tracking-cache

## Context and Problem

Several Tracking Query instances apply events to the same view. A read-compare-write in application code can interleave and write an older status over a newer one — the same "Delivered → On the Way" bug the case describes.

## Considered Alternatives

1. Read, compare and write from the service (no atomicity).
2. Redis optimistic transactions (`WATCH` / `MULTI` / `EXEC`) with retries.
3. A Lua script that compares version or sequence and writes atomically.

## Decision

Use a Lua script executed in Redis: it applies a status only if its version is higher and a location only if its sequence is higher, and sets the TTL when the status is terminal.

## Trade-offs

### Positives (what we gain)

- Atomic by construction; no retries needed.
- One round trip per event.

### Negatives (risks / what we lose)

- Logic lives partly in a script. *Mitigation:* the script is versioned, small and covered by integration tests.
- Long scripts block Redis. *Mitigation:* the script only touches one key.

## Final Justification

It is the simplest way to make the no-regression rule hold in the read model regardless of how many instances process events.
