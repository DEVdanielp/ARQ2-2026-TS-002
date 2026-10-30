# @libs/http

HTTP conventions of docs/spec.md section 2, shared by every service.

## Setup (main.ts)

```ts
import { createValidationPipe, ProblemDetailsFilter } from '@libs/http';

app.setGlobalPrefix('v1');                       // Kong keeps the /v1 prefix
app.useGlobalFilters(new ProblemDetailsFilter());
app.useGlobalPipes(createValidationPipe());
```

## What you get

Every error leaves as `application/problem+json`:

```json
{ "type": "https://api.fasttrack.local/errors/validation", "title": "Invalid request", "status": 400,
  "detail": "One or more fields are invalid.", "instance": "/v1/notifications/preferences",
  "correlationId": "0b7d0c1e-…", "errors": [{ "field": "push", "message": "push must be a boolean value" }] }
```

- Nest exceptions keep working: `throw new NotFoundException('Order not found')` → 404 problem.
- Custom problems: `throw problem(409, { type: 'invalid-transition', title: 'Invalid transition', detail: '…' })`.
- Unexpected errors → 500 with a generic `detail`; the real error is logged, never sent.
- DTO validation: unknown fields are rejected, so clients cannot send things
  like `customerId` (identity always comes from the JWT).
- `correlationId` is copied from the `X-Correlation-Id` header that Kong adds.

## OpenAPI / Swagger

```ts
import { ApiProblemResponses, buildOpenApiDocument, setupSwagger } from '@libs/http';

// controller
@ApiTags('Orders') @ApiBearerAuth() @ApiProblemResponses(401, 403, 500)
@Controller('orders')
export class OrdersController {
  @Post() @ApiOperation({ summary: 'Create an order' })
  @ApiCreatedResponse({ type: OrderDto }) @ApiProblemResponses(400)
  create(@Body() body: CreateOrderDto) { ... }
}

// main.ts
const document = buildOpenApiDocument(app, { title: 'FastTrack · Orders', description: '...',
  servers: [['http://localhost:3030', 'local run']] });
setupSwagger(app, 'v1/orders/docs', document);   // UI + v1/orders/docs-json
```

- `ApiProblemResponses(...)` documents the error statuses with the shared
  `ProblemDetailsDto` schema (`application/problem+json`).
- Add `@ApiProperty` to every DTO field next to its class-validator rules.
  The Nest CLI Swagger plugin does not run under rspack, so be explicit.
- Export the document to `docs/openapi/<service>.json` (see the Notification
  Service's `--openapi` flag in its `main.ts`) and add it to the `swagger-ui`
  service's `URLS` in `docker-compose.yml`, so the whole team sees it at
  <http://localhost:8090>.
