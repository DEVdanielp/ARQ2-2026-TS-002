# FastTrack — Contract Specification (OpenSpec)

**Team 002 · FastTrack – Last-Mile Logistics · Wave 1**

1. [Overview](#1-overview)
2. [Conventions](#2-conventions)
3. [Data schemas](#3-data-schemas)
4. [REST APIs](#4-rest-apis)
5. [Asynchronous events](#5-asynchronous-events)
6. [Requirements and scenarios](#6-requirements-and-scenarios)

---

## 1. Overview

FastTrack is split into microservices, one per bounded context. Services communicate **only through Kafka events**; no service reads another service's database or calls another service synchronously. External clients enter only through the **API Gateway (Kong)**, which validates JWTs issued by **Keycloak**.

| Service (container) | Feature | Responsibility | Owns |
| --- | --- | --- | --- |
| **Profiles & Assignment Service** | F1 | Customer and driver profiles, driver availability and capacity; assigns each new order to an available driver. | `profiles-db` (PostgreSQL) |
| **GPS Ingestion API** | F2 | Receives GPS batches (1–50 points), validates them and publishes them to Kafka keyed by driver. Returns `202`; never processes points. | — (stateless) |
| **GPS Tracking Worker** | F2, F5 | Processes each driver's points strictly in sequence order, stores the append-only history, updates the last known location and detects proximity (NEARBY). | `tracking-db` (PostgreSQL) |
| **Orders Service** | F4 | State engine. Receives intents over REST, queues them per order in Kafka and applies only valid transitions. Source of truth for the order status. | `orders-db` (PostgreSQL) |
| **Tracking Query Service** | F3 | CQRS read side. Builds one view per order in Redis from events, serves it over REST and SSE, and serves route audit from its archive. | `tracking-cache` (Redis), `query-archive-db` (PostgreSQL) |
| **Notification Service** | F5 | Sends push/email on ON_THE_WAY, NEARBY, DELIVERED and CANCELLED, once per type and order; manages preferences; retries with backoff. | `notifications-db` (PostgreSQL) |

Supporting containers: **API Gateway** (Kong OSS, DB-less), **Identity Provider** (Keycloak, OIDC), **Event Bus** (Apache Kafka, KRaft). External systems: **Push Provider** (Firebase Cloud Messaging), **Email Provider** (SMTP; MailHog locally), **Maps/ETA Provider**.

### Order lifecycle

```
CREATED ──PickupConfirmed (driver)──▶ ON_THE_WAY ──DeliveryConfirmed (driver)──▶ DELIVERED
   │                                      │
   └─CancellationRequested (customer)     └─CancellationRequested (operations, reason required)
                 ▼                                           ▼
             CANCELLED ◀─────────────────────────────────────┘
```

- `DELIVERED` and `CANCELLED` are terminal. `DELIVERED → CANCELLED` is not allowed.
- Driver assignment happens while the order is `CREATED`; it is not a status.
- GPS points and signal loss never change the status.

### Order fulfillment saga (choreography)

The order lifecycle spans several services with separate databases, so it runs as a **saga by choreography** over Kafka ([ADR-016](adr/016-order-fulfillment-saga-choreography.md)). Each service runs a local transaction and publishes its event through the transactional outbox; there is no orchestrator, and Orders is the only service that changes the order status.

| # | Service | Local transaction | Publishes | Compensation |
| --- | --- | --- | --- | --- |
| 1 | Orders | Create the order in `CREATED` | `OrderCreated` | Customer cancellation while `CREATED` → `OrderCancelled` |
| 2 | Profiles & Assignment | Choose an available driver, reserve capacity | `DriverAssigned` | Release capacity on `OrderCancelled`; `DriverUnassigned` if the driver goes offline before pickup |
| 3 | Orders | Record the driver on the order | — | Clear the driver on `DriverUnassigned` |
| 4 | Orders | Apply `PickupConfirmed`: `CREATED → ON_THE_WAY` | `OrderOnTheWay` | Operations cancellation with reason → `OrderCancelled` |
| 5 | GPS Tracking Worker | Monitor the order, process points in order | `LocationUpdated`, `DriverNearDestination` | Stop monitoring on `OrderCancelled` |
| 6 | Orders | Apply `DeliveryConfirmed`: `ON_THE_WAY → DELIVERED` | `OrderDelivered` | None: terminal |
| 7 | Profiles, GPS Tracking, Notifications | Release capacity, stop monitoring, notify | — | None: notifications are retried, never compensated |

**Failure paths**

- **No driver available:** Profiles & Assignment retries every 30 s for up to 10 minutes. If no driver is assigned, it publishes `AssignmentFailed`; operations staff are alerted and the order stays `CREATED` (it is not cancelled automatically).
- **Driver goes offline before pickup:** Profiles & Assignment publishes `DriverUnassigned` for each of the driver's `CREATED` orders and restarts the assignment (ends in `DriverAssigned` or `AssignmentFailed`). Intents from the previous driver are rejected.
- **Cancellation mid-saga:** `OrderCancelled` is the compensation event for every participant.

**Consistency rules:** events of one order travel on different topics, so consumers tolerate any arrival order (status by `aggregateVersion`, assignment events for terminal orders ignored, locations by `sequence`); every step is idempotent and publishes through the outbox; compensations never delete history.

---

## 2. Conventions

| Topic | Rule |
| --- | --- |
| Base URL | All endpoints are exposed by the gateway: `http://localhost:8000` |
| Authentication | `Authorization: Bearer <JWT>` issued by Keycloak (RS256). The token carries `sub` (user id) and `realm_access.roles` with one of `CUSTOMER`, `DRIVER`, `OPERATIONS`. Kong rejects missing or invalid tokens with `401` before reaching any service. |
| Identity | Services never accept a user id in the body for "me" endpoints; they use the JWT `sub`. |
| Correlation | Kong adds `X-Correlation-Id` (UUID) to every request; services copy it into every event they publish (`correlationId`). |
| Idempotency | `POST /orders` and `POST /orders/{orderId}/intents` accept an optional `Idempotency-Key` header (UUID). A repeated key within 24 h returns the original response. |
| IDs | UUID v4 strings. |
| Time | ISO-8601 in UTC (`2026-10-18T15:04:05Z`). GPS points carry the **device** time. |
| Coordinates | WGS-84 decimal degrees; `lat` ∈ [-90, 90], `lng` ∈ [-180, 180]. |
| Content type | `application/json; charset=utf-8`, except SSE (`text/event-stream`). |
| Errors | `application/problem+json` (RFC 7807), see below. |
| Rate limiting | Per user, enforced by Kong. Exceeding it returns `429` with `Retry-After`. |

### Error body (all services)

```json
{
  "type": "https://api.fasttrack.local/errors/invalid-transition",
  "title": "Invalid transition",
  "status": 409,
  "detail": "Order 6f1c… is DELIVERED; CancellationRequested is not allowed.",
  "instance": "/v1/orders/6f1c…/intents",
  "correlationId": "0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11",
  "errors": [{ "field": "reason", "message": "required for OPERATIONS" }]
}
```

### Common status codes

| Code | Meaning |
| --- | --- |
| `400` | Malformed body or failed validation. |
| `401` | Missing, expired or invalid JWT (returned by Kong). |
| `403` | Valid JWT but the role or ownership does not allow the action. |
| `404` | Resource not found (or not visible to the caller). |
| `409` | Conflict with the current state (e.g., terminal order). |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |
| `503` | A dependency (Kafka, database) is temporarily unavailable; the client may retry. |

---

## 3. Data schemas

Main domain schemas, expressed as OpenAPI 3 components. REST payloads and event payloads reuse them.

```yaml
openapi: 3.0.3
info:
  title: FastTrack shared schemas
  version: 1.0.0
paths: {}
components:
  schemas:
    OrderStatus:
      type: string
      enum: [CREATED, ON_THE_WAY, DELIVERED, CANCELLED]

    IntentType:
      type: string
      enum: [PICKUP_CONFIRMED, DELIVERY_CONFIRMED, CANCELLATION_REQUESTED]

    Actor:
      type: string
      enum: [CUSTOMER, DRIVER, OPERATIONS, SYSTEM]

    Location:
      type: object
      required: [lat, lng]
      properties:
        lat: { type: number, format: double, minimum: -90, maximum: 90 }
        lng: { type: number, format: double, minimum: -180, maximum: 180 }

    Destination:
      type: object
      required: [address, location]
      properties:
        address: { type: string, maxLength: 300, example: "Cra 43A #1-50, Medellín" }
        location: { $ref: '#/components/schemas/Location' }

    # ---------- Profiles & Assignment ----------
    Customer:
      type: object
      required: [customerId, name, email]
      properties:
        customerId: { type: string, format: uuid, description: "Equals the JWT sub" }
        name: { type: string, maxLength: 120 }
        email: { type: string, format: email }
        phone: { type: string, example: "+573001234567" }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    DriverAvailability:
      type: string
      enum: [AVAILABLE, EN_ROUTE, OFFLINE]

    Driver:
      type: object
      required: [driverId, name, availability, capacity]
      properties:
        driverId: { type: string, format: uuid, description: "Equals the JWT sub" }
        name: { type: string, maxLength: 120 }
        phone: { type: string }
        vehiclePlate: { type: string, example: "ABC123" }
        availability: { $ref: '#/components/schemas/DriverAvailability' }
        capacity: { type: integer, minimum: 1, maximum: 10, description: "Max concurrent orders" }
        activeOrderIds: { type: array, items: { type: string, format: uuid } }

    # ---------- Orders ----------
    Order:
      type: object
      required: [orderId, customerId, destination, status, version, createdAt]
      properties:
        orderId: { type: string, format: uuid }
        customerId: { type: string, format: uuid }
        driverId: { type: string, format: uuid, nullable: true }
        destination: { $ref: '#/components/schemas/Destination' }
        status: { $ref: '#/components/schemas/OrderStatus' }
        version: { type: integer, minimum: 1, description: "Increases on every change" }
        cancellation:
          type: object
          nullable: true
          properties:
            actor: { $ref: '#/components/schemas/Actor' }
            reason: { type: string, maxLength: 300 }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    # ---------- GPS ----------
    GpsPoint:
      type: object
      required: [lat, lng, deviceTime, sequence]
      properties:
        lat: { type: number, format: double, minimum: -90, maximum: 90 }
        lng: { type: number, format: double, minimum: -180, maximum: 180 }
        deviceTime: { type: string, format: date-time }
        sequence: { type: integer, format: int64, minimum: 0, description: "Monotonic per driver device" }
        accuracyMeters: { type: number, minimum: 0 }
        speedKmh: { type: number, minimum: 0 }

    PointBatch:
      type: object
      required: [points]
      properties:
        points:
          type: array
          minItems: 1
          maxItems: 50
          items: { $ref: '#/components/schemas/GpsPoint' }

    # ---------- Tracking Query ----------
    TrackingView:
      type: object
      required: [orderId, status, version, trackingAvailable]
      properties:
        orderId: { type: string, format: uuid }
        status: { $ref: '#/components/schemas/OrderStatus' }
        version: { type: integer }
        driverId: { type: string, format: uuid, nullable: true }
        driverName: { type: string, nullable: true }
        assignmentStatus:
          type: string
          enum: [PENDING, ASSIGNED, FAILED]
          description: "PENDING while looking for a driver; FAILED after AssignmentFailed"
        destination: { $ref: '#/components/schemas/Destination' }
        lastLocation:
          allOf: [{ $ref: '#/components/schemas/Location' }]
          nullable: true
        lastLocationDeviceTime: { type: string, format: date-time, nullable: true }
        lastSequence: { type: integer, format: int64, nullable: true }
        locationAgeSeconds: { type: integer, nullable: true, description: "Computed at read time" }
        trackingAvailable: { type: boolean, description: "false when location age >= 300 s" }
        nearbyReached: { type: boolean }
        lastRejectedIntent:
          type: object
          nullable: true
          properties:
            type: { $ref: '#/components/schemas/IntentType' }
            reason: { type: string }
            at: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    RoutePoint:
      type: object
      required: [lat, lng, deviceTime, sequence]
      properties:
        lat: { type: number }
        lng: { type: number }
        deviceTime: { type: string, format: date-time }
        sequence: { type: integer, format: int64 }

    # ---------- Notifications ----------
    NotificationType:
      type: string
      enum: [ORDER_CREATED, ON_THE_WAY, NEARBY, DELIVERED, CANCELLED]

    NotificationPreferences:
      type: object
      required: [push, email]
      properties:
        push: { type: boolean, default: true }
        email: { type: boolean, default: true }
        notifyOnCreated: { type: boolean, default: false, description: "CREATED notification is optional" }

    NotificationLogEntry:
      type: object
      properties:
        orderId: { type: string, format: uuid }
        type: { $ref: '#/components/schemas/NotificationType' }
        channel: { type: string, enum: [PUSH, EMAIL] }
        status: { type: string, enum: [SENT, FAILED, RETRYING, DEAD_LETTERED] }
        attempts: { type: integer }
        sentAt: { type: string, format: date-time, nullable: true }

    # ---------- Events ----------
    EventEnvelope:
      type: object
      required: [eventId, eventType, schemaVersion, occurredAt, producer, correlationId, aggregateId, payload]
      properties:
        eventId: { type: string, format: uuid, description: "Unique; used for idempotency" }
        eventType: { type: string, example: OrderDelivered }
        schemaVersion: { type: integer, example: 1 }
        occurredAt: { type: string, format: date-time }
        producer: { type: string, example: orders-service }
        correlationId: { type: string, format: uuid }
        aggregateId: { type: string, format: uuid, description: "orderId, driverId or customerId" }
        aggregateVersion: { type: integer, nullable: true, description: "Order version for order events" }
        payload: { type: object }
```

### Storage ownership (summary)

| Database | Owner | Main tables / keys |
| --- | --- | --- |
| `profiles-db` | Profiles & Assignment | `customers`, `drivers`, `assignments`, `outbox` |
| `orders-db` | Orders | `orders` (versioned), `processed_events`, `idempotency_keys`, `outbox` |
| `tracking-db` | GPS Tracking Worker | `driver_routes`, `gps_points` (append-only, partitioned by month), `outbox` |
| `tracking-cache` | Tracking Query | `tracking:view:{orderId}` (hash), Pub/Sub channel `tracking:changes` |
| `query-archive-db` | Tracking Query | `order_snapshots`, `route_points` |
| `notifications-db` | Notifications | `notification_log` (`UNIQUE(order_id, type, channel)`), `preferences`, `contacts`, `devices` |

---

## 4. REST APIs

All paths are relative to `http://localhost:8000`. Every endpoint can also return `401` (Kong), `429` (Kong) and `500`; they are listed only where they need explanation.

### 4.1 Profiles & Assignment Service

#### `GET /customers/me`

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Request body | — |
| Responses | `200` Customer · `401` · `403` role is not CUSTOMER · `404` profile not created yet · `500` |

```http
GET /v1/customers/me
Authorization: Bearer eyJhbGciOi...
```
```json
200 OK
{ "customerId": "3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10", "name": "Laura Gómez", "email": "laura@example.com", "phone": "+573001234567", "createdAt": "2026-10-01T14:00:00Z", "updatedAt": "2026-10-10T09:12:00Z" }
```

#### `PUT /customers/me`

Creates or updates the caller's profile. A change of email or phone publishes `CustomerContactUpdated`.

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Request body | `{ name, email, phone? }` |
| Responses | `200` updated · `201` created · `400` invalid email/phone · `401` · `403` · `500` |

```http
PUT /v1/customers/me
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "name": "Laura Gómez", "email": "laura@example.com", "phone": "+573001234567" }
```
```json
201 Created
{ "customerId": "3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10", "name": "Laura Gómez", "email": "laura@example.com", "phone": "+573001234567", "createdAt": "2026-10-18T15:00:00Z", "updatedAt": "2026-10-18T15:00:00Z" }
```

#### `PUT /drivers/me`

| | |
| --- | --- |
| Auth | JWT, role `DRIVER` |
| Request body | `{ name, phone, vehiclePlate }` |
| Responses | `200` updated · `201` created · `400` · `401` · `403` · `500` |

```json
PUT /v1/drivers/me
{ "name": "Carlos Ruiz", "phone": "+573109876543", "vehiclePlate": "ABC123" }

201 Created
{ "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "name": "Carlos Ruiz", "phone": "+573109876543", "vehiclePlate": "ABC123", "availability": "OFFLINE", "capacity": 3, "activeOrderIds": [] }
```

#### `PATCH /drivers/me/availability`

| | |
| --- | --- |
| Auth | JWT, role `DRIVER` |
| Request body | `{ availability: "AVAILABLE" \| "OFFLINE" }` (`EN_ROUTE` is set by the system) |
| Responses | `200` Driver · `400` invalid value · `401` · `403` · `404` driver profile missing · `409` cannot go `OFFLINE` with orders `ON_THE_WAY` · `500` |

Going `OFFLINE` with orders still in `CREATED` is allowed: each of those orders is released with `DriverUnassigned` and reassigned (see the saga in section 1).

```json
PATCH /v1/drivers/me/availability
{ "availability": "AVAILABLE" }

200 OK
{ "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "availability": "AVAILABLE", "capacity": 3, "activeOrderIds": [] }
```

#### `PATCH /drivers/{driverId}/capacity`

| | |
| --- | --- |
| Auth | JWT, role `OPERATIONS` |
| Request body | `{ capacity: integer 1–10 }` |
| Responses | `200` Driver · `400` out of range · `401` · `403` · `404` · `409` capacity lower than current active orders · `500` |

```json
PATCH /v1/drivers/9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d/capacity
{ "capacity": 4 }

200 OK
{ "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "availability": "EN_ROUTE", "capacity": 4, "activeOrderIds": ["6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10"] }
```

#### `GET /assignments?orderId={orderId}`

| | |
| --- | --- |
| Auth | JWT, role `OPERATIONS` |
| Request body | — |
| Responses | `200` `{ orderId, driverId, assignedAt, releasedAt? }` · `401` · `403` · `404` no assignment yet · `500` |

```json
200 OK
{ "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "assignedAt": "2026-10-18T15:01:10Z", "releasedAt": null }
```

### 4.2 Orders Service

#### `POST /orders`

Creates an order in `CREATED` and publishes `OrderCreated` (via outbox).

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Headers | `Idempotency-Key` (optional, UUID) |
| Request body | `{ destination: Destination, notes? }` |
| Responses | `201` Order + `Location` header · `400` invalid destination · `401` · `403` · `409` same `Idempotency-Key` with a different body · `500` · `503` |

```http
POST /v1/orders
Authorization: Bearer eyJhbGciOi...
Idempotency-Key: 1f6e0c2a-77b1-4d0e-9a8f-2b3c4d5e6f70
Content-Type: application/json

{ "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } }, "notes": "Leave at reception" }
```
```json
201 Created
Location: /v1/orders/6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10
{ "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "customerId": "3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10", "driverId": null, "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } }, "status": "CREATED", "version": 1, "cancellation": null, "createdAt": "2026-10-18T15:01:00Z", "updatedAt": "2026-10-18T15:01:00Z" }
```

#### `GET /orders/{orderId}`

| | |
| --- | --- |
| Auth | JWT; `CUSTOMER` (owner), `DRIVER` (assigned driver) or `OPERATIONS` |
| Request body | — |
| Responses | `200` Order · `401` · `403` not owner / not assigned · `404` · `500` |

```json
200 OK
{ "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "customerId": "3c9f8a2e-1b7d-4c55-9a0e-6d2f4b1e7a10", "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } }, "status": "ON_THE_WAY", "version": 3, "cancellation": null, "createdAt": "2026-10-18T15:01:00Z", "updatedAt": "2026-10-18T15:20:00Z" }
```

#### `GET /orders?status={status}&page={n}&size={m}`

Lists the caller's orders (a customer sees their own; a driver sees assigned ones; operations sees all).

| | |
| --- | --- |
| Auth | JWT; any role |
| Request body | — |
| Responses | `200` `{ items: Order[], page, size, total }` · `400` invalid filter · `401` · `500` |

```json
200 OK
{ "items": [ { "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "status": "ON_THE_WAY", "version": 3, "createdAt": "2026-10-18T15:01:00Z" } ], "page": 0, "size": 20, "total": 1 }
```

#### `POST /orders/{orderId}/intents`

Submits an intent. Orders publishes it to `orders.intents` (key = `orderId`) and returns `202`; the state engine applies it asynchronously and in order. The final result is visible through the tracking view (status change or `lastRejectedIntent`).

| | |
| --- | --- |
| Auth | JWT. `PICKUP_CONFIRMED` / `DELIVERY_CONFIRMED`: `DRIVER` assigned to the order. `CANCELLATION_REQUESTED`: `CUSTOMER` owner or `OPERATIONS`. |
| Headers | `Idempotency-Key` (optional, UUID) |
| Request body | `{ type: IntentType, reason?: string }` — `reason` is required when the caller is `OPERATIONS` |
| Responses | `202` accepted for processing · `400` invalid type or missing reason · `401` · `403` role/ownership not allowed for this intent · `404` order not found · `409` order already terminal (fast pre-check) · `500` · `503` Kafka unavailable |

```http
POST /v1/orders/6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10/intents
Authorization: Bearer eyJhbGciOi...   (role OPERATIONS)
Content-Type: application/json

{ "type": "CANCELLATION_REQUESTED", "reason": "Failed delivery: recipient unreachable" }
```
```json
202 Accepted
{ "intentId": "c2d4e6f8-0a1b-4c3d-9e5f-7a8b9c0d1e2f", "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "type": "CANCELLATION_REQUESTED", "status": "QUEUED" }
```
```json
409 Conflict
{ "type": "https://api.fasttrack.local/errors/order-terminal", "title": "Order is in a terminal state", "status": 409, "detail": "Order 6f1c… is DELIVERED.", "correlationId": "0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11" }
```

> The `409` pre-check is an optimization. The authoritative validation is done by the state engine when it consumes the intent; a rejection there is recorded in `TrackingView.lastRejectedIntent`.

### 4.3 GPS Ingestion API

#### `POST /drivers/me/locations`

Receives a batch of 1–50 points, publishes `GpsBatchReceived` to `gps.batches` (key = `driverId` from the JWT) and returns immediately.

| | |
| --- | --- |
| Auth | JWT, role `DRIVER` |
| Request body | `PointBatch` |
| Responses | `202` `{ batchId, accepted }` · `400` empty batch, more than 50 points or invalid coordinates/time · `401` · `403` · `413` payload too large · `429` · `500` · `503` Kafka unavailable (the app keeps the batch and retries) |

```http
POST /v1/drivers/me/locations
Authorization: Bearer eyJhbGciOi...   (role DRIVER)
Content-Type: application/json

{ "points": [
  { "lat": 6.2442, "lng": -75.5812, "deviceTime": "2026-10-18T15:20:01Z", "sequence": 1041, "accuracyMeters": 8 },
  { "lat": 6.2439, "lng": -75.5807, "deviceTime": "2026-10-18T15:20:06Z", "sequence": 1042, "accuracyMeters": 7 }
] }
```
```json
202 Accepted
{ "batchId": "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", "accepted": 2 }
```
```json
400 Bad Request
{ "type": "https://api.fasttrack.local/errors/validation", "title": "Invalid batch", "status": 400, "detail": "A batch must contain between 1 and 50 points.", "errors": [{ "field": "points", "message": "size 63 > 50" }] }
```

### 4.4 Tracking Query Service

#### `GET /tracking/{orderId}`

Initial load of the per-order view. Reads Redis; for terminal orders older than 24 h, reads `query-archive-db`.

| | |
| --- | --- |
| Auth | JWT; `CUSTOMER` (owner) or `OPERATIONS` |
| Request body | — |
| Responses | `200` TrackingView · `401` · `403` · `404` · `500` · `503` Redis unavailable |

```json
200 OK
{ "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "status": "ON_THE_WAY", "version": 3, "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "driverName": "Carlos Ruiz",
  "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } },
  "lastLocation": { "lat": 6.2439, "lng": -75.5807 }, "lastLocationDeviceTime": "2026-10-18T15:20:06Z", "lastSequence": 1042,
  "locationAgeSeconds": 240, "trackingAvailable": true, "nearbyReached": false, "lastRejectedIntent": null, "updatedAt": "2026-10-18T15:20:07Z" }
```

`locationAgeSeconds` is computed at read time from `lastLocationDeviceTime`. When it is `>= 300`, `trackingAvailable` is `false` and the app shows "Tracking temporarily unavailable"; the `status` is never changed for this reason.

#### `GET /tracking/{orderId}/stream` (SSE)

Keeps an SSE stream; sends the full view whenever it changes.

| | |
| --- | --- |
| Auth | JWT; `CUSTOMER` (owner) or `OPERATIONS` |
| Headers | `Accept: text/event-stream`; optional `Last-Event-ID` (view version) on reconnection |
| Request body | — |
| Responses | `200` `text/event-stream` · `401` · `403` · `404` · `503` |

```
200 OK
Content-Type: text/event-stream

id: 3
event: tracking
data: {"orderId":"6f1c…","status":"ON_THE_WAY","version":3,"lastLocation":{"lat":6.2439,"lng":-75.5807},"locationAgeSeconds":5,"trackingAvailable":true,"nearbyReached":false}

: heartbeat

id: 4
event: tracking
data: {"orderId":"6f1c…","status":"ON_THE_WAY","version":4,"nearbyReached":true, ...}
```

- A heartbeat comment is sent every 15 s.
- On reconnection with `Last-Event-ID`, the server sends the current view if its version is higher.

#### `GET /tracking/{orderId}/route?from={iso}&to={iso}`

Route audit for operations, from the archive.

| | |
| --- | --- |
| Auth | JWT, role `OPERATIONS` |
| Request body | — |
| Responses | `200` `{ orderId, driverId, points: RoutePoint[] }` (ordered by `sequence`) · `400` invalid range · `401` · `403` · `404` · `500` |

```json
200 OK
{ "orderId": "6f1c2b7e-8d4a-4f3b-9e21-0c5a7d8e9f10", "driverId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
  "points": [ { "lat": 6.2442, "lng": -75.5812, "deviceTime": "2026-10-18T15:20:01Z", "sequence": 1041 },
              { "lat": 6.2439, "lng": -75.5807, "deviceTime": "2026-10-18T15:20:06Z", "sequence": 1042 } ] }
```

### 4.5 Notification Service

#### `GET /notifications/preferences`

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Request body | — |
| Responses | `200` NotificationPreferences (defaults if never set) · `401` · `403` · `500` |

```json
200 OK
{ "push": true, "email": true, "notifyOnCreated": false }
```

#### `PUT /notifications/preferences`

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Request body | NotificationPreferences |
| Responses | `200` NotificationPreferences · `400` · `401` · `403` · `500` |

```json
PUT /v1/notifications/preferences
{ "push": true, "email": false, "notifyOnCreated": false }

200 OK
{ "push": true, "email": false, "notifyOnCreated": false }
```

#### `PUT /notifications/devices`

Registers the device token used for push notifications.

| | |
| --- | --- |
| Auth | JWT, role `CUSTOMER` |
| Request body | `{ deviceToken: string, platform: "ANDROID" \| "IOS" \| "WEB" }` |
| Responses | `204` · `400` · `401` · `403` · `500` |

```json
PUT /v1/notifications/devices
{ "deviceToken": "fcm:dGhpcyBpcyBhIHRva2Vu…", "platform": "ANDROID" }

204 No Content
```

#### `GET /notifications/orders/{orderId}`

Delivery log for an order (support and auditing).

| | |
| --- | --- |
| Auth | JWT; `CUSTOMER` (owner) or `OPERATIONS` |
| Request body | — |
| Responses | `200` `NotificationLogEntry[]` · `401` · `403` · `404` · `500` |

```json
200 OK
[ { "orderId": "6f1c…", "type": "ON_THE_WAY", "channel": "PUSH", "status": "SENT", "attempts": 1, "sentAt": "2026-10-18T15:05:02Z" },
  { "orderId": "6f1c…", "type": "NEARBY", "channel": "PUSH", "status": "RETRYING", "attempts": 2, "sentAt": null } ]
```

---

## 5. Asynchronous events

### 5.1 Topics

| Topic | Key | Partitions | Producer | Content |
| --- | --- | --- | --- | --- |
| `gps.batches` | `driverId` | 24 | GPS Ingestion API | `GpsBatchReceived` |
| `orders.intents` | `orderId` | 12 | Orders Service | `PickupConfirmed`, `DeliveryConfirmed`, `CancellationRequested` |
| `orders.events` | `orderId` | 12 | Orders Service | `OrderCreated`, `OrderOnTheWay`, `OrderDelivered`, `OrderCancelled` |
| `assignment.events` | `orderId` | 12 | Profiles & Assignment | `DriverAssigned`, `DriverUnassigned`, `AssignmentFailed` |
| `profile.events` | `customerId` | 6 | Profiles & Assignment | `CustomerContactUpdated` |
| `tracking.locations` | `orderId` | 12 | GPS Tracking Worker | `LocationUpdated` |
| `tracking.proximity` | `orderId` | 12 | GPS Tracking Worker | `DriverNearDestination` |
| `notifications.retry` | `orderId` | 6 | Notification Service | `NotificationRetry` |
| `<topic>.dlq` | same as source | 1–3 | Any consumer | Messages that exhausted their retries |

All messages use the `EventEnvelope` (section 3) as the Kafka value, serialized as JSON. Headers: `eventType`, `correlationId`.

### 5.2 Global delivery guarantees

| Guarantee | Rule |
| --- | --- |
| Delivery | **At-least-once.** Producers use `acks=all` and idempotent producers; facts are published through a transactional **outbox**. Consumers commit offsets only after processing. |
| Ordering | Guaranteed **per key** (per partition). GPS is ordered per `driverId`; everything about one order is ordered per `orderId`. No global ordering. |
| Idempotency | Every consumer is idempotent: by `eventId` (`processed_events`), by `(driverId, sequence)` for GPS, by `aggregateVersion` / `sequence` guards in the read model, and by `UNIQUE(order, type, channel)` for notifications. |
| Retries | Transient consumer errors: 3 in-process retries with exponential backoff (200 ms, 1 s, 5 s), then the message goes to `<topic>.dlq`. Notifications use the `notifications.retry` topic (see `NotificationRetry`). |
| Schema evolution | Additive changes only within the same `schemaVersion`; breaking changes increase it and consumers support both during migration. |

### 5.3 AsyncAPI summary

```yaml
asyncapi: 2.6.0
info:
  title: FastTrack events
  version: 1.0.0
servers:
  kafka:
    url: kafka:9092
    protocol: kafka
channels:
  gps.batches:
    publish:  { operationId: publishGpsBatch,   message: { name: GpsBatchReceived } }
    subscribe: { operationId: processGpsBatch,  message: { name: GpsBatchReceived } }
    bindings: { kafka: { partitions: 24 } }
  orders.intents:
    publish:  { message: { oneOf: [ { name: PickupConfirmed }, { name: DeliveryConfirmed }, { name: CancellationRequested } ] } }
  orders.events:
    publish:  { message: { oneOf: [ { name: OrderCreated }, { name: OrderOnTheWay }, { name: OrderDelivered }, { name: OrderCancelled } ] } }
  assignment.events:
    publish:  { message: { oneOf: [ { name: DriverAssigned }, { name: DriverUnassigned }, { name: AssignmentFailed } ] } }
  profile.events:
    publish:  { message: { name: CustomerContactUpdated } }
  tracking.locations:
    publish:  { message: { name: LocationUpdated } }
  tracking.proximity:
    publish:  { message: { name: DriverNearDestination } }
  notifications.retry:
    publish:  { message: { name: NotificationRetry } }
```

### 5.4 Event catalog

Every event below is wrapped in the `EventEnvelope`; only the `payload` is shown.

#### `GpsBatchReceived`

| | |
| --- | --- |
| Producer | GPS Ingestion API |
| Consumers | GPS Tracking Worker |
| Topic / key | `gps.batches` / `driverId` |
| Ordering | Per driver (partition). The worker additionally sorts points inside the batch by `sequence`. |
| Idempotency | Points with `sequence <= lastSequence` for the driver are ignored. |
| Retries | 3 in-process retries, then `gps.batches.dlq`. |

```json
{ "driverId": "9a1b2c3d-…", "batchId": "5e6f7a8b-…", "receivedAt": "2026-10-18T15:20:07Z",
  "points": [ { "lat": 6.2442, "lng": -75.5812, "deviceTime": "2026-10-18T15:20:01Z", "sequence": 1041 } ] }
```

#### `PickupConfirmed` / `DeliveryConfirmed` / `CancellationRequested` (intents)

| | |
| --- | --- |
| Producer | Orders Service (from the REST request) |
| Consumers | Orders Service (state engine) |
| Topic / key | `orders.intents` / `orderId` |
| Ordering | Per order: intents for one order are applied one at a time. |
| Idempotency | By `eventId` (`intentId`) in `processed_events`; an intent that does not match a valid transition is rejected and recorded, never retried. |
| Retries | 3 in-process retries for technical errors, then `orders.intents.dlq`. |

```json
{ "intentId": "c2d4e6f8-…", "orderId": "6f1c2b7e-…", "type": "CANCELLATION_REQUESTED",
  "actor": "OPERATIONS", "actorId": "7b8c9d0e-…", "reason": "Failed delivery: recipient unreachable", "requestedAt": "2026-10-18T15:30:00Z" }
```

#### `OrderCreated`

| | |
| --- | --- |
| Producer | Orders Service (outbox) |
| Consumers | Profiles & Assignment, Tracking Query, Notifications (only if `notifyOnCreated`) |
| Topic / key | `orders.events` / `orderId` |
| Ordering | Per order. `aggregateVersion = 1`. |
| Idempotency | Consumers ignore an `orderId` + version already applied. |
| Retries | 3 in-process retries, then `orders.events.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "customerId": "3c9f8a2e-…", "status": "CREATED",
  "destination": { "address": "Cra 43A #1-50, Medellín", "location": { "lat": 6.2088, "lng": -75.5679 } } }
```

#### `DriverAssigned`

| | |
| --- | --- |
| Producer | Profiles & Assignment (outbox) |
| Consumers | Orders, GPS Tracking Worker, Tracking Query |
| Topic / key | `assignment.events` / `orderId` |
| Ordering | Per order. |
| Idempotency | By `eventId`; at most one active assignment per order. |
| Retries | 3 in-process retries, then `assignment.events.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "driverId": "9a1b2c3d-…", "driverName": "Carlos Ruiz",
  "destination": { "location": { "lat": 6.2088, "lng": -75.5679 } }, "assignedAt": "2026-10-18T15:01:10Z" }
```

#### `DriverUnassigned` (saga compensation)

| | |
| --- | --- |
| Producer | Profiles & Assignment (outbox) |
| Consumers | Orders (clears the driver), GPS Tracking Worker (removes the order from the route), Tracking Query |
| Topic / key | `assignment.events` / `orderId` |
| Ordering | Per order, after the `DriverAssigned` it revokes. |
| Idempotency | By `eventId`; ignored if the order is not assigned to `driverId` anymore or is not `CREATED`. |
| Retries | 3 in-process retries, then `assignment.events.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "driverId": "9a1b2c3d-…", "reason": "DRIVER_OFFLINE", "unassignedAt": "2026-10-18T15:06:00Z" }
```

#### `AssignmentFailed` (saga timeout)

| | |
| --- | --- |
| Producer | Profiles & Assignment (outbox), when no driver is assigned within 10 minutes |
| Consumers | Tracking Query (`assignmentStatus = FAILED`), Notifications (alert to operations staff) |
| Topic / key | `assignment.events` / `orderId` |
| Ordering | Per order. |
| Idempotency | At most once per assignment window; consumers deduplicate by `eventId`. The order status does not change. |
| Retries | 3 in-process retries, then `assignment.events.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "attempts": 20, "windowStartedAt": "2026-10-18T15:01:00Z", "failedAt": "2026-10-18T15:11:00Z" }
```

#### `OrderOnTheWay` / `OrderDelivered` / `OrderCancelled`

| | |
| --- | --- |
| Producer | Orders Service (outbox), after a valid transition |
| Consumers | GPS Tracking Worker, Profiles & Assignment (Delivered, Cancelled), Tracking Query, Notifications |
| Topic / key | `orders.events` / `orderId` |
| Ordering | Per order; `aggregateVersion` increases by 1 on every transition. |
| Idempotency | Consumers apply an event only if its `aggregateVersion` is higher than the one they stored, so a late or duplicate event never moves an order backward. |
| Retries | 3 in-process retries, then `orders.events.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "status": "CANCELLED", "previousStatus": "ON_THE_WAY",
  "driverId": "9a1b2c3d-…", "cancellation": { "actor": "OPERATIONS", "reason": "Failed delivery: recipient unreachable" },
  "changedAt": "2026-10-18T15:30:01Z" }
```

#### `LocationUpdated`

| | |
| --- | --- |
| Producer | GPS Tracking Worker (outbox), one event per in-progress order of the driver |
| Consumers | Tracking Query |
| Topic / key | `tracking.locations` / `orderId` |
| Ordering | Per order. |
| Idempotency | Tracking Query applies it only if `sequence` is higher than the stored one. |
| Retries | 3 in-process retries, then `tracking.locations.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "driverId": "9a1b2c3d-…",
  "location": { "lat": 6.2439, "lng": -75.5807 }, "deviceTime": "2026-10-18T15:20:06Z", "sequence": 1042 }
```

#### `DriverNearDestination` (NEARBY)

| | |
| --- | --- |
| Producer | GPS Tracking Worker (outbox) |
| Consumers | Notifications, Tracking Query |
| Topic / key | `tracking.proximity` / `orderId` |
| Ordering | Per order. |
| Idempotency | Emitted at most once per order (flag in the driver route); consumers also deduplicate by `orderId`. |
| Retries | 3 in-process retries, then `tracking.proximity.dlq`. |

```json
{ "orderId": "6f1c2b7e-…", "driverId": "9a1b2c3d-…", "trigger": "DISTANCE",
  "distanceMeters": 430, "etaSeconds": 260, "location": { "lat": 6.2121, "lng": -75.5701 }, "detectedAt": "2026-10-18T15:42:10Z" }
```

`trigger` is `DISTANCE` (< 500 m) or `ETA` (< 300 s).

#### `CustomerContactUpdated`

| | |
| --- | --- |
| Producer | Profiles & Assignment (outbox) |
| Consumers | Notifications |
| Topic / key | `profile.events` / `customerId` |
| Ordering | Per customer. |
| Idempotency | Consumers keep the copy with the highest `aggregateVersion`. |
| Retries | 3 in-process retries, then `profile.events.dlq`. |

```json
{ "customerId": "3c9f8a2e-…", "name": "Laura Gómez", "email": "laura@example.com", "phone": "+573001234567" }
```

#### `NotificationRetry`

| | |
| --- | --- |
| Producer | Notification Service |
| Consumers | Notification Service (`RetryConsumer`) |
| Topic / key | `notifications.retry` / `orderId` |
| Ordering | Not required (notification order is not a business rule). |
| Idempotency | `UNIQUE(order, type, channel)` in the notification log; a notification already `SENT` is skipped. |
| Retries | Exponential backoff (1 min, 5 min, 15 min). After 3 attempts the message goes to `notifications.retry.dlq` and the log entry is marked `DEAD_LETTERED`. |

```json
{ "orderId": "6f1c2b7e-…", "customerId": "3c9f8a2e-…", "type": "NEARBY", "channel": "PUSH",
  "attempt": 2, "notBefore": "2026-10-18T15:48:10Z", "lastError": "FCM 503 Service Unavailable" }
```

---

## 6. Requirements and scenarios

### F1 — Profile management and order-to-driver assignment

| ID | Scenario |
| --- | --- |
| F1-S1 | **WHEN** an authenticated customer calls `PUT /customers/me` with a valid name and email **THEN** the profile is stored with `customerId` = JWT `sub`, the service returns `201`, and `CustomerContactUpdated` is published. |
| F1-S2 | **WHEN** `OrderCreated` is consumed and at least one driver is `AVAILABLE` with free capacity **THEN** Profiles & Assignment assigns the order to that driver, publishes `DriverAssigned`, and the order remains `CREATED`. |
| F1-S3 | **WHEN** `OrderCreated` is consumed and no driver is available **THEN** the order stays `CREATED`, the view shows `assignmentStatus = PENDING`, and Profiles & Assignment retries every 30 seconds. |
| F1-S3b | **WHEN** no driver has been assigned 10 minutes after `OrderCreated` **THEN** `AssignmentFailed` is published, operations staff are alerted, the view shows `assignmentStatus = FAILED` and the order stays `CREATED` (it is not cancelled automatically). |
| F1-S4 | **WHEN** a driver whose active orders equal their capacity is evaluated **THEN** no new order is assigned to them. |
| F1-S5 | **WHEN** `OrderDelivered` or `OrderCancelled` is consumed **THEN** the driver's capacity is released and, if they have no active orders, their availability returns to `AVAILABLE`. |
| F1-S6 | **WHEN** an assigned driver changes to `OFFLINE` while one of their orders is still `CREATED` **THEN** `DriverUnassigned` is published for that order, Orders clears the driver, and the assignment restarts until it ends in `DriverAssigned` or `AssignmentFailed`. |

### F2 — Asynchronous, strictly sequential GPS ingestion

| ID | Scenario |
| --- | --- |
| F2-S1 | **WHEN** a driver sends a batch of 1–50 valid points to `POST /drivers/me/locations` **THEN** the API publishes `GpsBatchReceived` keyed by the driver id and returns `202` without processing the points. |
| F2-S2 | **WHEN** a batch with 0 or more than 50 points is sent **THEN** the API returns `400` and nothing is published. |
| F2-S3 | **WHEN** a driver reconnects and sends a batch of 50 points whose sequences arrive out of order **THEN** the worker processes them sorted by `sequence`, appends all of them to the history, and the last known location becomes the point with the highest sequence. |
| F2-S4 | **WHEN** a batch contains points whose `sequence` was already processed **THEN** those points are ignored and the location does not move backward. |
| F2-S5 | **WHEN** GPS points arrive for an order that is already `DELIVERED` **THEN** they are only appended to the history and the order status does not change. |

### F3 — Optimized current order status query

| ID | Scenario |
| --- | --- |
| F3-S1 | **WHEN** a customer opens the tracking screen of an active order **THEN** `GET /tracking/{orderId}` returns the view from Redis without querying PostgreSQL, and the app then receives updates through the SSE stream instead of polling. |
| F3-S2 | **WHEN** the last location is less than 5 minutes old **THEN** the view returns the location with `trackingAvailable = true` and the app shows "Updated X min ago". |
| F3-S3 | **WHEN** no GPS point has arrived for 5 minutes or more **THEN** the view returns the last known location with `trackingAvailable = false`, the app shows "Tracking temporarily unavailable", and the `status` is unchanged. |
| F3-S4 | **WHEN** a status event arrives with an `aggregateVersion` lower than or equal to the stored one **THEN** the view is not modified (no regression). |
| F3-S5 | **WHEN** an order reaches `DELIVERED` or `CANCELLED` **THEN** its view stays in Redis for 24 h; **WHEN** it is queried after 24 h **THEN** it is served from `query-archive-db`. |

### F4 — Event-driven state transition engine

| ID | Scenario |
| --- | --- |
| F4-S1 | **WHEN** the assigned driver submits `PICKUP_CONFIRMED` for an order in `CREATED` **THEN** the API returns `202`, the state engine consumes the intent, the order moves to `ON_THE_WAY` with a higher version, and `OrderOnTheWay` is published. |
| F4-S2 | **WHEN** the driver submits `DELIVERY_CONFIRMED` for an order in `ON_THE_WAY` **THEN** the order moves to `DELIVERED` and `OrderDelivered` is published. |
| F4-S3 | **WHEN** the customer submits `CANCELLATION_REQUESTED` for an order in `CREATED` **THEN** the order moves to `CANCELLED` and `OrderCancelled` is published. |
| F4-S4 | **WHEN** the customer submits `CANCELLATION_REQUESTED` for an order in `ON_THE_WAY` **THEN** the API returns `403` and the order is unchanged. |
| F4-S5 | **WHEN** operations staff submit `CANCELLATION_REQUESTED` with a reason for an order in `ON_THE_WAY` **THEN** the order moves to `CANCELLED` with the reason recorded; **WHEN** the reason is missing **THEN** the API returns `400`. |
| F4-S6 | **WHEN** any intent arrives for an order in `DELIVERED` or `CANCELLED` **THEN** it is rejected (`409` on the pre-check, or recorded in `lastRejectedIntent` by the engine) and the order never leaves its terminal state. |
| F4-S7 | **WHEN** the same intent is delivered twice by Kafka **THEN** it is applied only once (idempotency by `eventId`). |
| F4-S8 | **WHEN** a driver who was unassigned (`DriverUnassigned`) submits `PICKUP_CONFIRMED` for that order **THEN** the API returns `403` (or the engine records it in `lastRejectedIntent`) and the order is unchanged. |
| F4-S9 | **WHEN** `DriverAssigned` arrives for an order that is already `CANCELLED` **THEN** Orders ignores it, Profiles & Assignment has already released the driver, and the status stays `CANCELLED`. |

### F5 — Proactive proximity notifications

| ID | Scenario |
| --- | --- |
| F5-S1 | **WHEN** a processed point places the driver less than 500 m from the destination, or the ETA is under 5 minutes, for an order in `ON_THE_WAY` **THEN** `DriverNearDestination` is published once and the customer receives a push and/or email according to their preferences. |
| F5-S2 | **WHEN** later points keep the driver inside the proximity zone **THEN** no second NEARBY notification is sent for that order. |
| F5-S3 | **WHEN** `OrderOnTheWay`, `OrderDelivered` or `OrderCancelled` is consumed **THEN** the customer is notified once for each type. |
| F5-S4 | **WHEN** the push provider fails **THEN** the notification is retried with backoff through `notifications.retry`, GPS ingestion and state transitions continue unaffected, and after 3 failed attempts the message goes to the DLQ. |
| F5-S5 | **WHEN** the customer has disabled email in their preferences **THEN** no email is sent for any notification type. |