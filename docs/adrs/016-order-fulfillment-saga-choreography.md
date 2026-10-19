# ADR-016: Order fulfillment saga by choreography over Kafka

- **Status:** Accepted
- **Features:** F1, F4, F5
- **Containers involved:** Orders, Profiles & Assignment, GPS Tracking Worker, Notification Service, Tracking Query

## Context and Problem

Creating, assigning, picking up and delivering an order spans Orders, Profiles & Assignment, GPS Tracking and Notifications, each with its own database (ADR-003). A distributed transaction is not available across independent PostgreSQL databases and Kafka, yet the process must stay consistent when a step fails: no driver available, a driver going offline before pickup, or a cancellation in the middle of the flow.

## Considered Alternatives

1. Distributed transaction (two-phase commit) across the services.
2. Orchestrated saga: Orders, or a dedicated orchestrator, sends commands to each service and keeps the saga state.
3. Choreographed saga: each service reacts to events, runs its local transaction, publishes its own event through the outbox and defines its compensation.

## Decision

Option 3. Steps: `OrderCreated` → `DriverAssigned` → `OrderOnTheWay` → `LocationUpdated` / `DriverNearDestination` → `OrderDelivered`. Compensations are explicit events: `OrderCancelled` (release capacity, stop monitoring) and `DriverUnassigned` (driver goes offline before pickup). If no driver is assigned within 10 minutes (retries every 30 s), Profiles & Assignment publishes `AssignmentFailed`, operations staff are alerted and the order stays `CREATED`. Orders remains the only component that changes the order status.

## Trade-offs

### Positives (what we gain)

- No central coordinator to build, scale and keep available.
- Services stay decoupled: a new consumer (for example, analytics) needs no change in the others.
- Fits the event-driven design required by F4 and reuses the outbox (ADR-005) and idempotency (ADR-009) already in place.

### Negatives (risks / what we lose)

- The flow is spread across services and harder to follow end to end. *Mitigation:* the saga steps are documented in the TS-002 document and every event carries `X-Correlation-Id`.
- Unexpected event chains may appear as the system grows. *Mitigation:* each event has a single owner and every new subscription is reviewed.
- Timeouts must be implemented by a participant. *Mitigation:* Profiles & Assignment schedules the 10-minute assignment deadline.
- Events of one order travel on different topics, so their arrival order is not guaranteed. *Mitigation:* consumers apply status by version, ignore assignments for terminal orders and apply locations by sequence.

## Final Justification

The flow is short and linear and every participant already reacts to events. Two-phase commit is not viable across independent databases and Kafka, and an orchestrator would centralize logic and couple Orders to every service. If the flow grows (for example, with payments or returns), the decision can be revisited in favor of orchestration.
