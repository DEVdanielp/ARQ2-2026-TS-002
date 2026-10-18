# ADR-003: Microservices with a database per service and event-only communication

- **Status:** Accepted
- **Features:** F1–F5
- **Containers involved:** All services

## Context and Problem

The five features have very different loads: massive GPS writes, massive tracking reads and low-volume profile management. Today everything is coupled through one PostgreSQL database and synchronous calls, so a load peak or a slow dependency affects the whole system. Notifications must never block ingestion or transitions.

## Considered Alternatives

1. Keep a monolith with REST and a shared database.
2. Modular monolith, separating only GPS ingestion and the query side.
3. Microservices, one per bounded context, each with its own database, communicating only through Kafka and exposed through an API Gateway.

## Decision

Each bounded context is a microservice with its own database. Services communicate only through Kafka events; external clients enter only through the API Gateway. No service reads another service's database or calls another service synchronously.

## Trade-offs

### Positives (what we gain)

- Each service scales independently (GPS and Query carry the load).
- Failure isolation: a push provider outage does not affect status transitions.
- Clear ownership, mapped one-to-one to the bounded contexts.

### Negatives (risks / what we lose)

- More deployables to build, run and monitor. *Mitigation:* containers and a single `docker-compose` for local development.
- Distributed debugging. *Mitigation:* `X-Correlation-Id` propagated in every request and event, centralized logs.
- Eventual consistency and data duplication (projections, contact copies). *Mitigation:* see ADR-015; the consistency of the order lifecycle across services is handled by the saga in ADR-016.

## Final Justification

The case's problems come from coupling between reads, GPS processing and status changes. Separating them by bounded context and connecting them only through events removes that coupling.
