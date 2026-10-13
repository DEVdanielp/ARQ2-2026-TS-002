# Specification — ARQ2-2026-TS-002

> Contract for Wave 2. Code is reviewed against this file: if behavior is not described here, it is not required; if it is described here, it must be implemented as written.
>
> - **Status:** Draft
> - **Version:** 0.1.0
> - **Related:** [ADRs](adrs/) · [C1 Context](assets/C1-Context.drawio.png) · [C2 Containers](assets/C2-Containers.drawio.png)

---

## 1. Overview

### 1.1 Purpose

<!-- TODO: One paragraph describing the system and the problem it solves. -->

### 1.2 Scope

| Feature | Name | Owner service(s) | Key ADRs |
|---------|------|------------------|----------|
| F1 | <!-- TODO --> Profiles & assignment | Profiles & Assignment | 003, 005, 007, 015 |
| F2 | Sequential GPS ingestion | GPS Ingestion API, GPS Tracking Worker | 001, 005, 009, 011 |
| F3 | Order tracking (read model + real time) | Tracking Query Service | 002, 004, 010 |
| F4 | Event-driven order state transitions | Orders Service | 005, 006, 009 |
| F5 | Notifications (incl. NEARBY) | Notification Service | 009, 012, 013, 015 |

**Out of scope:** <!-- TODO -->

### 1.3 Actors and roles

| Role (JWT claim) | Client | Description |
|------------------|--------|-------------|
| `CUSTOMER` | Customer App | <!-- TODO --> |
| `DRIVER` | Driver App | <!-- TODO --> |
| `OPERATIONS` | Operations Console | <!-- TODO --> |

### 1.4 Cross-cutting conventions

- **Entry point:** all external traffic goes through Kong (ADR-008). Kafka is internal.
- **Authentication:** RS256 JWT issued by Keycloak, validated by Kong via JWKS (ADR-007).
- **Correlation:** every request carries `X-Correlation-Id`; it is propagated to every event header.
- **Delivery semantics:** at-least-once; every consumer is idempotent (ADR-009).
- **Publishing:** facts are published via transactional outbox (ADR-005).
- **Errors:** <!-- TODO: error body format (e.g. RFC 7807 problem+json) -->
- **Time & IDs:** <!-- TODO: timestamps in ISO-8601 UTC; IDs as UUIDv4? -->

---

## 2. Domain schemas

> Per bounded context. Each service owns its data (ADR-003); replicated fields are listed explicitly (ADR-015).

### 2.1 Profiles & Assignment

<!-- TODO: Customer, Driver, Assignment -->

```yaml
# TODO
Customer: {}
Driver: {}
```

### 2.2 Orders

<!-- TODO: Order aggregate, state machine, processed_events -->

```yaml
Order:
  id: uuid
  status: CREATED | ON_THE_WAY | DELIVERED | CANCELLED
  version: integer        # monotonic, increases on every transition
  # TODO
```

**State machine**

| From | Intent / event | To | Allowed role |
|------|----------------|----|--------------|
| `CREATED` | `PickupConfirmed` | `ON_THE_WAY` | `DRIVER` |
| `ON_THE_WAY` | `DeliveryConfirmed` | `DELIVERED` | `DRIVER` |
| `CREATED` | `CancellationRequested` | `CANCELLED` | `CUSTOMER`, `OPERATIONS` |
| <!-- TODO --> | | | |

### 2.3 GPS Tracking

```yaml
GpsPoint:
  driverId: uuid
  sequence: integer       # strictly increasing per driver
  deviceTimestamp: date-time
  lat: number
  lng: number
  # TODO
```

### 2.4 Tracking Query (read model)

```yaml
OrderTrackingView:
  orderId: uuid
  status: string
  statusVersion: integer
  location: { lat: number, lng: number, sequence: integer }
  driver: {}              # replicated from DriverAssigned
  # TODO
```

### 2.5 Notifications

```yaml
Notification:
  orderId: uuid
  type: string            # UNIQUE(orderId, type)
  # TODO
```

---

## 3. REST APIs

> Paths as exposed by the API Gateway. Embedded OpenAPI 3 is allowed.

### 3.1 Endpoint summary

| Method | Path | Service | Roles | Feature | Response |
|--------|------|---------|-------|---------|----------|
| <!-- TODO --> | | Profiles & Assignment | | F1 | |
| `POST` | `/gps/batches` <!-- TODO confirm --> | GPS Ingestion API | `DRIVER` | F2 | `202` |
| `GET` | `/orders/{id}/tracking` <!-- TODO confirm --> | Tracking Query | `CUSTOMER` | F3 | `200` |
| `GET` | `/orders/{id}/tracking/stream` <!-- TODO confirm --> | Tracking Query | `CUSTOMER` | F3 | SSE |
| `POST` | `/orders/{id}/intents` | Orders Service | `DRIVER`, `CUSTOMER`, `OPERATIONS` | F4 | `202` |

### 3.2 OpenAPI

```yaml
openapi: 3.0.3
info:
  title: ARQ2-2026-TS-002 Public API
  version: 0.1.0
paths: {}            # TODO
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  schemas: {}        # TODO
security:
  - bearerAuth: []
```

---

## 4. Asynchronous events

> Embedded AsyncAPI is allowed. All events share a common envelope.

### 4.1 Event envelope

```yaml
eventId: uuid           # idempotency key
eventType: string
occurredAt: date-time
correlationId: string
aggregateId: uuid       # equals the Kafka key
version: integer
payload: {}
```

### 4.2 Topic catalog

| Topic | Key | Producer | Consumers | Events | ADR |
|-------|-----|----------|-----------|--------|-----|
| `gps.batches` | `driverId` | GPS Ingestion API | GPS Tracking Worker | `GpsBatchReceived` | 001 |
| `orders.intents` | `orderId` | Orders Service (REST) | Orders `IntentConsumer` | `PickupConfirmed`, `DeliveryConfirmed`, `CancellationRequested` | 006 |
| <!-- TODO orders.events --> | `orderId` | Orders Service | Tracking Query, Notifications | `OrderCreated`?, `OrderDelivered`, … | 005 |
| <!-- TODO --> | | Profiles & Assignment | Tracking Query, Notifications | `DriverAssigned`, `CustomerContactUpdated` | 015 |
| <!-- TODO --> | `driverId` / `orderId` | GPS Tracking Worker | Tracking Query, Notifications | <!-- TODO location event --> | 001 |
| `notifications.retry` | `orderId` | Notification Service | `RetryConsumer` | <!-- TODO --> | 012 |
| `<topic>.dlq` | same | any consumer | manual review | original event | 012 |

### 4.3 AsyncAPI

```yaml
asyncapi: 2.6.0
info:
  title: ARQ2-2026-TS-002 Events
  version: 0.1.0
channels: {}         # TODO
components:
  messages: {}       # TODO
```

---

## 5. Scenarios (WHEN / THEN)

> Each scenario has an ID `F<n>-S<m>` so Wave 2 tests and reviews can reference it.

### 5.1 F1 — Profiles & assignment

**F1-S1 — <!-- TODO title -->**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

### 5.2 F2 — Sequential GPS ingestion

**F2-S1 — Batch accepted without blocking the driver**
- **GIVEN** an authenticated `DRIVER`
- **WHEN** they send a batch of up to 50 points
- **THEN** <!-- TODO -->

**F2-S2 — Out-of-order points are processed in sequence**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F2-S3 — Duplicate sequences are ignored**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

### 5.3 F3 — Order tracking

**F3-S1 — Active order is served from cache**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F3-S2 — Real-time update over SSE**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F3-S3 — Stale event does not regress the view**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F3-S4 — Terminal order after 24 h is read from archive**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

### 5.4 F4 — Event-driven state transitions

**F4-S1 — Valid transition**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F4-S2 — Invalid transition is rejected**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F4-S3 — Concurrent intents on the same order**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

### 5.5 F5 — Notifications

**F5-S1 — Notification sent once per order and type**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F5-S2 — NEARBY by distance or ETA**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

**F5-S3 — Provider failure goes to retry, then DLQ**
- **GIVEN** <!-- TODO -->
- **WHEN** <!-- TODO -->
- **THEN** <!-- TODO -->

---

## 6. Open questions

- <!-- TODO -->
