/**
 * OpenAPI (Swagger) document of the Orders Service.
 *
 * Served at `/v1/orders/docs` (UI) and `/v1/orders/docs-json`, and exported to
 * `docs/openapi/orders-service.json` with `main.js --openapi` (command in the
 * README), which is what the team's Swagger UI shows at http://localhost:8090.
 *
 * OpenAPI only describes HTTP; the Kafka events are summarised in the
 * description below (the full contract is spec 5.4, and AsyncAPI in spec 5.3).
 */
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '@libs/http';

export const SWAGGER_PATH = 'v1/orders/docs';

const DESCRIPTION = `
Orders Service (feature **F4**). The state engine and source of truth of the
order status: it receives intents over REST, queues them per order in Kafka and
applies only valid transitions. Owns \`orders-db\`. Contract: \`docs/spec.md\`
§1, §4.2, §5.4, F4; decisions in ADR-005, ADR-006, ADR-009 and ADR-016.

### Authentication
Every endpoint needs \`Authorization: Bearer <JWT>\` issued by Keycloak. Kong
verifies the token; the service checks the role (\`realm_access.roles\`) and
always takes the user id from the token's \`sub\`.

### Errors
All errors are \`application/problem+json\` (schema \`ProblemDetailsDto\`), with
the \`correlationId\` from \`X-Correlation-Id\`.

### Order lifecycle
\`\`\`
CREATED ──PICKUP_CONFIRMED (driver)──▶ ON_THE_WAY ──DELIVERY_CONFIRMED (driver)──▶ DELIVERED
   │                                       │
   └─CANCELLATION_REQUESTED (customer)     └─CANCELLATION_REQUESTED (operations, reason required)
                 ▼                                          ▼
             CANCELLED ◀────────────────────────────────────┘
\`\`\`
\`DELIVERED\` and \`CANCELLED\` are terminal. Assigning a driver is not a status,
but it does raise \`version\`.

### Idempotency
\`POST /orders\` and \`POST /orders/{orderId}/intents\` accept \`Idempotency-Key\`
(UUID). A repeated key within 24 h returns the original response; the same key
with a different body returns \`409\`.

### Events produced
| Topic (key) | Event | When |
| --- | --- | --- |
| \`orders.intents\` (orderId) | \`PickupConfirmed\`, \`DeliveryConfirmed\`, \`CancellationRequested\` | an intent was accepted (\`202\`) |
| \`orders.events\` (orderId) | \`OrderCreated\` | an order was created (outbox) |
| \`orders.events\` (orderId) | \`OrderOnTheWay\`, \`OrderDelivered\`, \`OrderCancelled\` | a valid transition (outbox) |
| \`orders.events\` (orderId) | \`IntentRejected\` | the state engine rejected an intent (outbox); carries \`lastRejectedIntent\` for the tracking view |

### Events consumed (Kafka, consumer group \`orders-service\`)
| Topic | Event | Effect |
| --- | --- | --- |
| \`orders.intents\` | the three intents above | the state engine applies or rejects them, one at a time per order |
| \`assignment.events\` | \`DriverAssigned\` | records the driver; ignored unless the order is \`CREATED\` |
| \`assignment.events\` | \`DriverUnassigned\` | clears the driver, whose later intents are rejected |
`.trim();

export function buildOrdersOpenApi(app: INestApplication): OpenAPIObject {
  return buildOpenApiDocument(app, {
    title: 'FastTrack · Orders Service',
    description: DESCRIPTION,
    version: '1.0.0',
    tags: [['Orders', 'Orders and their state transitions (spec 4.2)']],
    servers: [
      [
        'http://localhost:3040',
        'Orders Service run on the host (no Kong; see libs/auth README)',
      ],
    ],
  });
}
