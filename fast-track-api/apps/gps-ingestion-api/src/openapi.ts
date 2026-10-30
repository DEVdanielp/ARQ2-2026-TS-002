/**
 * OpenAPI (Swagger) document of the GPS Ingestion API.
 *
 * Served at `/v1/gps-ingestion/docs` (UI) and `/v1/gps-ingestion/docs-json`
 * when the service runs on the host (Kong only routes
 * `POST /v1/drivers/me/locations` to this service), and exported to
 * `docs/openapi/gps-ingestion-api.json` with
 * `node dist/apps/gps-ingestion-api/main.js --openapi <file>`.
 */
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '@libs/http';

export const SWAGGER_PATH = 'v1/gps-ingestion/docs';

const DESCRIPTION = `
GPS Ingestion API (feature **F2**). Receives batches of 1–50 GPS points from the
driver app, validates them and publishes them to Kafka keyed by driver. Returns
\`202\` as soon as Kafka confirms the write; it **never processes points** and
has no database. Contract: \`docs/spec.md\` §4.3, §5.4 (\`GpsBatchReceived\`), F2.

### Authentication
\`Authorization: Bearer <JWT>\` issued by Keycloak with role \`DRIVER\`. Kong
verifies the token; the service checks the role (\`realm_access.roles\`) and
always takes the driver id from the token's \`sub\`.

### Errors
All errors are \`application/problem+json\` (schema \`ProblemDetailsDto\`), with
the \`correlationId\` from \`X-Correlation-Id\`. Validation errors list every
invalid field, e.g. \`points.3.lat\`.

| Status | When |
| --- | --- |
| 400 | 0 or more than 50 points, coordinates out of range, time without zone, unknown field |
| 413 | Body larger than 64 KB |
| 429 | Rate limit of Kong (300 requests/minute per token) |
| 503 | Kafka did not confirm the batch: keep it and retry (duplicates are harmless) |

### Event produced
| Topic | Key | Event | Payload |
| --- | --- | --- | --- |
| \`gps.batches\` | \`driverId\` | \`GpsBatchReceived\` | \`{ driverId, batchId, receivedAt, points[] }\` (device times in UTC) |

The **GPS Tracking Worker** consumes it: it sorts points by \`sequence\`, ignores
sequences already processed, appends them to the history and advances the last
known location only with a higher sequence (ADR-001, ADR-018).
`.trim();

export function buildIngestionOpenApi(app: INestApplication): OpenAPIObject {
  return buildOpenApiDocument(app, {
    title: 'FastTrack · GPS Ingestion API',
    description: DESCRIPTION,
    version: '1.0.0',
    tags: [['GPS', 'Driver location batches (spec 4.3)']],
    servers: [['http://localhost:3010', 'GPS Ingestion API run on the host (no Kong; see libs/auth README)']],
  });
}
