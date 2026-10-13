# ADR-014: Hexagonal architecture inside each service

- **Status:** Proposed
- **Features:** F1–F5
- **Containers involved:** All services

## Context and Problem

The rules that fail today (sequential order, no regression) must be easy to test and must not depend on Kafka, Redis or PostgreSQL.

## Considered Alternatives

1. Classic layered architecture (controller → service → repository).
2. Transaction-script / CRUD services.
3. Hexagonal (ports and adapters): domain at the center, adapters at the edges.

## Decision

Each service has a domain layer (aggregates, value objects, policies), an application layer (use cases) and adapters. The domain defines ports; adapters implement them.

## Trade-offs

### Positives (what we gain)

- Domain rules are tested with plain unit tests.
- Infrastructure can be replaced by changing one adapter.
- The same use case serves REST and Kafka inputs.

### Negatives (risks / what we lose)

- More classes and mapping code. *Mitigation:* keep small services (GPS Ingestion API) minimal.
- Team needs a shared convention for packages and naming.

## Final Justification

The value of the system lies in a few critical rules; isolating them in the domain makes them verifiable and protects them from infrastructure changes.
