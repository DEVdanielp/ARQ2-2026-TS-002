/**
 * OpenAPI (Swagger) document of the Notification Service.
 *
 * Served at `/v1/notifications/docs` (UI) and `/v1/notifications/docs-json`,
 * and exported to `docs/openapi/notification-service.json` with
 * `node dist/apps/notification-service/main.js --openapi <file>`.
 *
 * OpenAPI only describes HTTP; the Kafka events are summarised in the
 * description below (the full contract is spec 5.4, and AsyncAPI in spec 5.3).
 */
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '@libs/http';

export const SWAGGER_PATH = 'v1/notifications/docs';

const DESCRIPTION = `
Notification Service (feature **F5**). Sends push and email notifications on
\`ON_THE_WAY\`, \`NEARBY\`, \`DELIVERED\` and \`CANCELLED\` (and \`ORDER_CREATED\` if
the customer opted in), **once per order, type and channel**; manages
preferences and push devices; retries failed sends; alerts operations when no
driver could be assigned. Contract: \`docs/spec.md\` §4.5, §5.4, F5.

### Authentication
Every endpoint needs \`Authorization: Bearer <JWT>\` issued by Keycloak. Kong
verifies the token; the service checks the role (\`realm_access.roles\`) and
always takes the customer id from the token's \`sub\`.

### Errors
All errors are \`application/problem+json\` (schema \`ProblemDetailsDto\`), with
the \`correlationId\` from \`X-Correlation-Id\`.

### Events consumed (Kafka, consumer group \`notification-service\`)
| Topic | Event | Effect |
| --- | --- | --- |
| \`orders.events\` | \`OrderCreated\` | remembers orderId → customerId; \`ORDER_CREATED\` notification only if \`notifyOnCreated\` |
| \`orders.events\` | \`OrderOnTheWay\`, \`OrderDelivered\`, \`OrderCancelled\` | notification \`ON_THE_WAY\`, \`DELIVERED\`, \`CANCELLED\` |
| \`tracking.proximity\` | \`DriverNearDestination\` | notification \`NEARBY\` (ignored after delivery/cancellation) |
| \`profile.events\` | \`CustomerContactUpdated\` | stores name/email/phone if \`aggregateVersion\` is newer |
| \`assignment.events\` | \`AssignmentFailed\` | email alert to the operations mailbox, once per event |
| \`notifications.retry\` | \`NotificationRetry\` | retries the failed channel |

### Events produced
| Topic | Event | When |
| --- | --- | --- |
| \`notifications.retry\` | \`NotificationRetry\` | a send failed; published through the outbox when due (1, 5, 15 min, ADR-017) |
| \`notifications.retry.dlq\` | \`NotificationRetry\` | the 3rd retry failed; the log entry becomes \`DEAD_LETTERED\` |
`.trim();

export function buildNotificationOpenApi(app: INestApplication): OpenAPIObject {
  return buildOpenApiDocument(app, {
    title: 'FastTrack · Notification Service',
    description: DESCRIPTION,
    version: '1.0.0',
    tags: [['Notifications', 'Preferences, push devices and delivery log (spec 4.5)']],
    servers: [['http://localhost:3020', 'Notification Service run on the host (no Kong; see libs/auth README)']],
  });
}
