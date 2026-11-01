# ADR-019: Driver assignment: eligibility, selection, retries and concurrency

- **Status:** Accepted
- **Features:** F1 (and the saga of ADR-016)
- **Containers involved:** Profiles & Assignment Service, profiles-db

## Context and Problem

The spec fixes what Profiles & Assignment must do (assign each new order to an available driver, retry every 30 s for up to 10 minutes, release capacity on `OrderDelivered`/`OrderCancelled`, publish `DriverUnassigned` when a driver goes offline before pickup), but implementing it left questions the spec and the ADRs do not answer, and one inconsistency:

1. **Who is eligible.** Drivers have a capacity of 1–10 concurrent orders and become `EN_ROUTE` while they have active orders, but F1-S2 says "a driver `AVAILABLE` with free capacity". Read literally, an `EN_ROUTE` driver could never get a second order and capacity would mean nothing.
2. **Which driver** to choose when several are eligible. Profiles has no driver location (it lives in the GPS service, and services never query each other, spec 1).
3. **Where the destination comes from.** `DriverAssigned` must carry `destination.location` (the GPS Tracking Worker sends events without it to the DLQ, ADR-018), but Profiles does not own orders.
4. **How "cannot go OFFLINE with orders ON_THE_WAY" (409) is known.** The spec lists Profiles as a consumer of `OrderDelivered` and `OrderCancelled` only, so it would never learn that an order was picked up.
5. **How the 30 s retries and the 10-minute deadline survive a restart**, and what `AssignmentFailed.attempts` counts.
6. **Concurrency:** two orders must never take the last free slot of the same driver, and a driver going offline must not race with an assignment.
7. **What `profiles-db` stores** beyond the four tables named in spec §3.

## Considered Alternatives

For eligibility (1):

1. Only `AVAILABLE` drivers (literal reading of F1-S2): capacity is useless above 1.
2. Any driver that is not `OFFLINE` and has fewer active orders than its capacity.

For concurrency (6):

1. Row locks on drivers and orders (`SELECT ... FOR UPDATE`), always in the same order.
2. One transaction-level advisory lock for every transaction that changes assignments.

## Decision

1. **Eligible = not `OFFLINE` and active orders < capacity (alternative 2).** `AVAILABLE` and `EN_ROUTE` are only what the driver shows: `EN_ROUTE` while they have active orders, `AVAILABLE` when they have none (F1-S5). The driver only chooses `AVAILABLE` or `OFFLINE`. This changes nothing for the other services: the GPS Tracking Worker already supports several monitored orders per driver (ADR-018, one `LocationUpdated` per monitored order).
2. **Selection:** fewest active orders first (spread the work), then the oldest last assignment (never assigned first), then the lowest `driverId` (deterministic). Distance is not part of the rule.
3. **Local copy of the order (ADR-015):** `OrderCreated` is stored in `assignment_requests` with its destination; `DriverAssigned` is built from it.
4. **Profiles also consumes `OrderOnTheWay`** (same topic and key as the other order events, so no new subscription). Status is applied by `aggregateVersion`. If `OrderOnTheWay` names a driver different from ours (a pickup accepted just before that driver went offline), Orders is the source of truth: our assignment follows it and `DriverAssigned` is published again for that driver, so the GPS Tracking Worker and Tracking Query follow too (a `DriverUnassigned` would be ignored, the order is no longer `CREATED`).
5. **The due time of every attempt is a database column** (`assignment_requests.next_attempt_at`), and a scheduler polls it every second (`ASSIGNMENT_SCHEDULER_INTERVAL_MS`). The first attempt happens when `OrderCreated` is consumed; when nobody is eligible the next one is due 30 s later; a due attempt after 10 minutes publishes `AssignmentFailed` instead (`attempts` = attempts made in the window: 20 with the defaults). After `AssignmentFailed` the order stays `CREATED` and is not retried automatically. `DriverUnassigned` restarts the window (new 10 minutes) and attempts a reassignment at once, excluding the driver who went offline.
6. **One advisory lock (alternative 2)** serializes the assignment transactions (`OrderCreated`, retries, order status events, availability, capacity, driver profile). It is deadlock-free and obviously correct; Profiles is the low-volume service (ADR-003), and with more volume it can become a per-driver lock. Customer profile updates take a per-customer advisory lock instead, so `CustomerContactUpdated` versions are never duplicated.
7. **Event times of one order are strictly increasing.** Consumers order `DriverAssigned` / `DriverUnassigned` / `AssignmentFailed` of an order by `assignedAt` / `unassignedAt` / `failedAt` and drop an event that is not newer than the last one applied (Tracking Query). When two of them are written in the same transaction (offline + immediate reassignment), the second is stamped 1 ms later.
8. **profiles-db tables:** `customers` (with `contact_version` = the `aggregateVersion` of `CustomerContactUpdated`), `drivers`, `assignment_requests` (point 3), `assignments` (history; a partial `UNIQUE` index allows one active assignment per order; `activeOrderIds` is derived from it), `processed_events` (ADR-009), `outbox` (ADR-005).

## Trade-offs

### Positives (what we gain)

- Capacity works as the spec describes (up to 10 concurrent orders) with no change in any other service.
- Retries and deadlines survive restarts; every step is idempotent (`processed_events`, `aggregateVersion`) and publishes through the outbox.
- No driver ever exceeds its capacity, even with concurrent events and requests.

### Negatives (risks / what we lose)

- The selection ignores distance. *Mitigation:* acceptable for Wave 1; a location-aware rule would need a local copy of driver positions (ADR-015), not a synchronous call.
- All assignment changes run one at a time. *Mitigation:* each transaction is a few short queries; replace with per-driver locks if the volume grows.
- After `AssignmentFailed` an order waits for operations: there is no endpoint to restart its assignment in Wave 1.
- Retry timing is approximate (30 s plus the scheduler interval). Acceptable: the spec fixes the cadence, not the exact second.

## Final Justification

These choices satisfy F1-S1…F1-S6 and F4-S9 together with ADR-003/005/009/015/016/018, add no technology, and keep every rule (eligibility, selection, window) a pure function tested in the domain layer (ADR-014).
