/**
 * OpenAPI (Swagger) document of the Tracking Query Service.
 *
 * Served at `/v1/tracking/docs` (UI) and `/v1/tracking/docs-json`, and
 * exported to `docs/openapi/tracking-query-service.json` with
 * `npm run openapi:tracking-query-service`.
 *
 * OpenAPI only describes HTTP; the Kafka events are summarised in the
 * description below (the full contract is spec 5.4).
 */
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '@libs/http';

export const SWAGGER_PATH = 'v1/tracking/docs';

const DESCRIPTION = `
Tracking Query Service (feature **F3**): the CQRS read side. Builds one view
per order in Redis from events, serves it over REST and Server-Sent Events, and
serves the route audit from its archive. It never changes an order. Contract:
\`docs/spec.md\` §4.4, §5.4, F3; ADR-002, ADR-004, ADR-010.

### Authentication
Every endpoint needs \`Authorization: Bearer <JWT>\` issued by Keycloak (the SSE
stream also accepts \`?jwt=<token>\`). Kong verifies the token; the service checks
the role (\`realm_access.roles\`) and that a customer only reads their own orders.

### Errors
All errors are \`application/problem+json\` (schema \`ProblemDetailsDto\`), with
the \`correlationId\` from \`X-Correlation-Id\`. \`503\` = Redis unavailable.

### Read model (tracking-cache, Redis)
One hash per order, \`tracking:view:{orderId}\`, written only through an atomic
Lua script that applies a status only with a higher \`aggregateVersion\` and a
location only with a higher \`sequence\` (no regression, F3-S4). Active orders
never expire; \`DELIVERED\`/\`CANCELLED\` views expire after 24 h and are then
served from \`query-archive-db\` (F3-S5). Every change is announced on the Pub/Sub
channel \`tracking:changes\`, so every instance pushes it to its SSE clients.

### Events consumed (Kafka, consumer group \`tracking-query-service\`)
| Topic | Event | Effect on the view |
| --- | --- | --- |
| \`orders.events\` | \`OrderCreated\` | creates it: \`CREATED\`, owner, destination, \`assignmentStatus = PENDING\` |
| \`orders.events\` | \`OrderOnTheWay\`, \`OrderDelivered\`, \`OrderCancelled\` | status, if \`aggregateVersion\` is higher; terminal -> 24 h expiry |
| \`assignment.events\` | \`DriverAssigned\` / \`DriverUnassigned\` / \`AssignmentFailed\` | driver and \`assignmentStatus\` \`ASSIGNED\` / \`PENDING\` / \`FAILED\` |
| \`tracking.locations\` | \`LocationUpdated\` | last location, if \`sequence\` is higher; point archived for the route audit |
| \`tracking.proximity\` | \`DriverNearDestination\` | \`nearbyReached = true\` |

Invalid payloads are retried and then parked in \`<topic>.dlq\` (\`@libs/kafka\`).

### Events produced
None.
`.trim();

export function buildTrackingOpenApi(app: INestApplication): OpenAPIObject {
  return buildOpenApiDocument(app, {
    title: 'FastTrack · Tracking Query Service',
    description: DESCRIPTION,
    version: '1.0.0',
    tags: [['Tracking', 'Per-order tracking view, live stream and route audit (spec 4.4)']],
    servers: [['http://localhost:3040', 'Tracking Query Service run on the host (no Kong; see libs/auth README)']],
  });
}
