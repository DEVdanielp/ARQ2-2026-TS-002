/**
 * OpenAPI (Swagger) document of the Profiles & Assignment Service.
 *
 * Served at `/v1/profiles/docs` (UI) and `/v1/profiles/docs-json` when the
 * service runs on the host (Kong only routes /v1/customers, /v1/drivers and
 * /v1/assignments to this service), and exported to
 * `docs/openapi/profiles-service.json` with `npm run openapi:profiles-service`.
 *
 * OpenAPI only describes HTTP; the Kafka events are summarised in the
 * description below (the full contract is spec 5.4, and AsyncAPI in spec 5.3).
 */
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '@libs/http';

export const SWAGGER_PATH = 'v1/profiles/docs';

const DESCRIPTION = `
Profiles & Assignment Service (feature **F1**). Customer and driver profiles,
driver availability and capacity, and the assignment of every new order to an
available driver (step 2 of the order fulfillment saga, ADR-016). Owns
\`profiles-db\`. Contract: \`docs/spec.md\` §4.1, §5.4, F1; decisions in ADR-019.

### Authentication
Every endpoint needs \`Authorization: Bearer <JWT>\` issued by Keycloak. Kong
verifies the token; the service checks the role (\`realm_access.roles\`) and
always takes the customer/driver id from the token's \`sub\`.

### Errors
All errors are \`application/problem+json\` (schema \`ProblemDetailsDto\`), with
the \`correlationId\` from \`X-Correlation-Id\`.

### How a driver is chosen (ADR-019)
Eligible = not \`OFFLINE\` and fewer active orders than their capacity
(\`EN_ROUTE\` drivers with a free slot are eligible). Among them: fewest active
orders, then the one whose last assignment is oldest. If nobody is eligible the
order is retried every **30 s**; after **10 min** \`AssignmentFailed\` is
published and the order stays \`CREATED\`.

### Events consumed (Kafka, consumer group \`profiles-service\`)
| Topic | Event | Effect |
| --- | --- | --- |
| \`orders.events\` | \`OrderCreated\` | stores the order and its destination; assigns a driver at once or starts the retries |
| \`orders.events\` | \`OrderOnTheWay\` | the order is picked up: its driver can no longer go \`OFFLINE\` (409) |
| \`orders.events\` | \`OrderDelivered\`, \`OrderCancelled\` | releases the driver's slot; back to \`AVAILABLE\` with no active orders; stops the retries |

### Events produced (through the transactional outbox)
| Topic (key) | Event | When |
| --- | --- | --- |
| \`assignment.events\` (orderId) | \`DriverAssigned\` | a driver was assigned (payload: driverName, destination.location, assignedAt) |
| \`assignment.events\` (orderId) | \`DriverUnassigned\` | the driver went \`OFFLINE\` before pickup (reason \`DRIVER_OFFLINE\`); the assignment restarts |
| \`assignment.events\` (orderId) | \`AssignmentFailed\` | no driver within 10 minutes; the order stays \`CREATED\` |
| \`profile.events\` (customerId) | \`CustomerContactUpdated\` | a customer profile was created, or its email/phone changed (\`aggregateVersion\` increases) |
`.trim();

export function buildProfilesOpenApi(app: INestApplication): OpenAPIObject {
  return buildOpenApiDocument(app, {
    title: 'FastTrack · Profiles & Assignment Service',
    description: DESCRIPTION,
    version: '1.0.0',
    tags: [
      ['Customers', 'Customer profile of the caller (spec 4.1)'],
      ['Drivers', 'Driver profile, availability and capacity (spec 4.1)'],
      ['Assignments', 'Order-to-driver assignments, for operations (spec 4.1)'],
    ],
    servers: [
      [
        'http://localhost:3050',
        'Profiles Service run on the host (no Kong; see libs/auth README)',
      ],
    ],
  });
}
