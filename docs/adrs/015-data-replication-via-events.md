# ADR-015: Data needed by another service is replicated through events

- **Status:** Accepted
- **Features:** F1, F5
- **Containers involved:** Profiles & Assignment, Notification Service, Tracking Query

## Context and Problem

Some services need data they do not own: Notifications needs the customer's contact data; Tracking Query needs the driver assigned to an order. Without shared databases or synchronous calls, they cannot query the owner.

## Considered Alternatives

1. Synchronous call to the owner service when the data is needed.
2. Shared read access to the owner's database.
3. The owner publishes an event and consumers keep a local copy.

## Decision

Owners publish events (`CustomerContactUpdated`, `DriverAssigned`, `DriverUnassigned`) and consumers store only the fields they need. A removal (for example, `DriverUnassigned`) is replicated the same way as a creation.

## Trade-offs

### Positives (what we gain)

- No runtime coupling: the consumer works even if the owner is down.
- Respects database-per-service.

### Negatives (risks / what we lose)

- Copies are eventually consistent. *Mitigation:* events carry versions; consumers keep the latest.
- Duplicated data must be handled carefully for privacy. *Mitigation:* copy only the fields needed.

## Final Justification

It is the only option consistent with ADR-003 that does not reintroduce synchronous dependencies between services.
