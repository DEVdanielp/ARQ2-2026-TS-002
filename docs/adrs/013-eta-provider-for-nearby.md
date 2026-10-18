# ADR-013: ETA calculation for the NEARBY rule

- **Status:** Accepted
- **Features:** F5
- **Containers involved:** GPS Tracking Worker, Maps/ETA Provider

## Context and Problem

NEARBY fires when the driver is within 500 m or the ETA is under 5 minutes. Distance can be computed locally; ETA needs a routing provider, which costs money, adds latency and has rate limits.

## Considered Alternatives

1. Distance only (straight line, 500 m); no ETA.
2. External routing API for every GPS point.
3. External routing API only when the driver is close (e.g., < 3 km), with caching and timeout.

## Decision

Compute straight-line distance for every point; call the ETA provider only within 3 km of the destination, at most once per minute per order, with a short timeout. If the provider fails, fall back to distance only.

## Trade-offs

### Positives (what we gain)

- Meets both criteria of the rule.
- Bounded cost and calls; ingestion never waits on the provider for long.

### Negatives (risks / what we lose)

- External dependency in the GPS path. *Mitigation:* timeout, cache and distance fallback.
- Thresholds (3 km, 1 min) are assumptions to validate.

## Final Justification

It satisfies the case's rule while keeping the provider off the critical path for most points.
