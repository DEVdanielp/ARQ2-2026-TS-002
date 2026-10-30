# ADR-018: GPS tracking state, late points and monitored orders

- **Status:** Accepted
- **Features:** F2, F5
- **Containers involved:** GPS Ingestion API, GPS Tracking Worker, tracking-db, Maps/ETA Provider

## Context and Problem

ADR-001 and ADR-011 fix the GPS pipeline (Kafka keyed by driver, append-only history in monthly partitions), but implementing it left questions the spec and the ADRs do not answer, and one inconsistency:

1. **Late points.** Spec §5.4 says points with `sequence <= lastSequence` are *ignored*. ADR-001 says the worker "ignores sequences already processed, appends to the history and advances the location only with a higher sequence", and ADR-011 says *every* point must be kept for auditing. A point that was never seen but is older than the last location (for example, two requests of the app published out of order) is "ignored" by the first rule and "kept" by the other two.
2. **Which orders get `LocationUpdated` and NEARBY**, and how the worker knows them, since the events of one order arrive on different topics in any order (ADR-016).
3. **How many `LocationUpdated`** per batch ("one event per in-progress order of the driver").
4. **What `tracking-db` stores** beyond the three tables named in spec §3.
5. **Concurrency** if two worker instances briefly consume the same partition during a rebalance.
6. **The Maps/ETA provider's API**, which the spec names but does not define, and the meaning of `etaSeconds` when it was not consulted.
7. **What the API answers** when Kafka does not confirm a batch, and how large a body may be.

## Considered Alternatives

For the late points (1):

1. Follow §5.4 literally: drop every point with `sequence <= lastSequence`, even if it was never stored.
2. Store every sequence **not yet stored** for the driver; move the location only with a higher sequence.

For the order state (2):

1. Query Orders synchronously: forbidden by spec §1 and ADR-003.
2. Keep a local copy fed by `DriverAssigned`, `DriverUnassigned` and the order status events (ADR-015).

## Decision

1. **Late points are stored, never applied (alternative 2).** History = every distinct `(driverId, sequence)` once. Location, `LocationUpdated` and NEARBY only consider points with `sequence > lastSequence`. Spec §5.4 is reworded accordingly. It keeps F2-S4 ("already processed → ignored; the location does not move backward") and ADR-011 (nothing is lost).
2. **Monitored order** = an order assigned to the driver (`DriverAssigned`, destination included), in `ON_THE_WAY` (latest `aggregateVersion` seen) and not unassigned. Only these get `LocationUpdated` and the NEARBY check. Before pickup the driver's position is not the package's; after `DELIVERED`/`CANCELLED` points are only stored (F2-S5). The copy is order-tolerant: status by version; `DriverAssigned` ignored for terminal orders; `DriverUnassigned` applied only if the order is still that driver's and still `CREATED`; assignment events deduplicated by `eventId`. `OrderOnTheWay.driverId` fills the driver if `DriverAssigned` has not arrived yet.
3. **One `LocationUpdated` per monitored order per batch**, carrying the new last location (highest sequence). Tracking Query keeps only the latest location, so one event per point would be load without value.
4. **tracking-db tables:** `driver_routes` (one row per driver: last location and `last_sequence`, the guard of F2-S4), `route_orders` (the local copy of point 2, plus the NEARBY flag and the ETA throttle), `gps_points` (partitioned by month of `device_time`, `UNIQUE (driver_id, sequence, device_time)`, a `DEFAULT` partition for out-of-range clocks), `processed_events`, `outbox`. Monthly partitions (previous, current, next two months) are created by the worker at startup and daily.
5. **One transaction per batch holding the driver's row lock** (`SELECT ... FOR UPDATE` on `driver_routes`): history, location, NEARBY flag and events (outbox) commit together, and two batches of one driver never interleave, even across instances.
6. **ETA provider:** contract `GET {ETA_PROVIDER_URL}?originLat&originLng&destinationLat&destinationLng → { "etaSeconds": n }` (a thin proxy can adapt any routing product). Asked before the transaction (no lock held), only for the batch's latest point, within 3 km, at most once per minute per order, with a 2 s timeout; empty URL or failure → distance only. `etaSeconds` is `null` in `DriverNearDestination` when the provider was not consulted.
7. **API:** Kafka is written directly (no database, so no outbox) and the request waits at most `GPS_PUBLISH_TIMEOUT_MS` (5 s) for the acknowledgement, then answers `503`; the app retries and duplicates are dropped by sequence. Bodies above 64 KB answer `413` (50 points take ~8 KB). Device times must carry a zone and are normalised to UTC.

## Trade-offs

### Positives (what we gain)

- The audit trail is complete and the location never regresses, whatever the arrival order.
- Every rule is idempotent and enforced by SQL (`ON CONFLICT`, conditional `UPDATE`), so redeliveries, app retries and rebalances are harmless.
- No synchronous dependency on Orders, Profiles or the ETA provider in the GPS path.

### Negatives (risks / what we lose)

- A late point near the destination does not trigger NEARBY. *Mitigation:* acceptable, it is not the current position; the next current point decides.
- `route_orders` is eventually consistent: for a moment after `OrderDelivered` a batch may still publish one `LocationUpdated`. *Mitigation:* rows are locked during the batch, and Tracking Query applies locations by sequence without changing the status.
- The `UNIQUE` constraint includes `device_time` (PostgreSQL requires the partition key). A device that re-sends a sequence with a different time is caught by the worker's "already stored" check, not by the constraint.
- A partition cannot be created while the `DEFAULT` partition holds rows of that month (a clock far ahead). *Mitigation:* the worker logs a warning; those points stay queryable in `gps_points_default`.
- The ETA contract is an assumption until a provider is chosen.

## Final Justification

These choices satisfy the F2/F5 scenarios and ADR-001/009/011/013/015/016 together, add no technology, and keep every rule testable in the domain layer (ADR-014).
