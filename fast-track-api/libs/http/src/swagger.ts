/**
 * OpenAPI (Swagger) helpers shared by every service.
 *
 * - `ProblemDetailsDto`: the error body of spec section 2, as an OpenAPI schema.
 * - `ApiProblemResponses(...)`: documents the error statuses of an endpoint
 *   with that schema in one line.
 * - `buildOpenApiDocument()` / `setupSwagger()`: the common document settings
 *   (bearer JWT, servers) and the Swagger UI route.
 *
 * Decorators are written explicitly (no Nest CLI Swagger plugin): the services
 * are bundled with rspack, which does not run that plugin.
 */
import { applyDecorators, type INestApplication } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { STATUS_CODES } from 'node:http';

export class FieldErrorDto {
  @ApiProperty({ example: 'push' })
  field: string;

  @ApiProperty({ example: 'push must be a boolean value' })
  message: string;
}

/** RFC 7807 body returned for every error (spec section 2). */
export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://api.fasttrack.local/errors/validation' })
  type: string;

  @ApiProperty({ example: 'Invalid request' })
  title: string;

  @ApiProperty({ example: 400 })
  status: number;

  @ApiPropertyOptional({ example: 'One or more fields are invalid.' })
  detail?: string;

  @ApiProperty({ example: '/v1/notifications/preferences' })
  instance: string;

  @ApiPropertyOptional({ example: '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11', description: 'Copied from X-Correlation-Id' })
  correlationId?: string;

  @ApiPropertyOptional({ type: [FieldErrorDto], description: 'Only for validation errors' })
  errors?: FieldErrorDto[];
}

/** What each status means in FastTrack (spec 2, Common status codes). */
const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed body or failed validation',
  401: 'Missing, expired or invalid JWT (returned by Kong)',
  403: 'Valid JWT but the role or ownership does not allow the action',
  404: 'Resource not found (or not visible to the caller)',
  409: 'Conflict with the current state',
  429: 'Rate limit exceeded (Kong)',
  500: 'Unexpected server error',
  503: 'A dependency is temporarily unavailable',
};

/**
 * Documents error responses as `application/problem+json`.
 *
 * @example @ApiProblemResponses(400, 401, 403)
 */
export function ApiProblemResponses(...statuses: number[]): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: STATUS_DESCRIPTIONS[status] ?? STATUS_CODES[status],
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' } } },
      }),
    ),
  );
}

export interface OpenApiOptions {
  title: string;
  description: string;
  version?: string;
  /** Tags with their descriptions, in display order. */
  tags?: Array<[name: string, description: string]>;
  /** Extra servers besides Kong, e.g. the service's local port. */
  servers?: Array<[url: string, description: string]>;
}

/** Builds the OpenAPI document of a service with the FastTrack conventions. */
export function buildOpenApiDocument(app: INestApplication, options: OpenApiOptions): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setDescription(options.description)
    .setVersion(options.version ?? '1.0.0')
    // Public entry point is Kong (spec 2, Base URL); a service can also be
    // called directly in local development.
    .addServer('http://localhost:8000', 'API Gateway (Kong)');
  for (const [url, description] of options.servers ?? []) builder.addServer(url, description);
  builder.addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Keycloak access token' });
  for (const [name, description] of options.tags ?? []) builder.addTag(name, description);

  return SwaggerModule.createDocument(app, builder.build(), { extraModels: [ProblemDetailsDto, FieldErrorDto] });
}

/** Serves Swagger UI at `/<path>` and the raw document at `/<path>-json`. */
export function setupSwagger(app: INestApplication, path: string, document: OpenAPIObject): void {
  SwaggerModule.setup(path, app, document, {
    jsonDocumentUrl: `${path}-json`,
    swaggerOptions: { persistAuthorization: true },
  });
}
