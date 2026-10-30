import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiOkResponse } from '@nestjs/swagger';
import { ApiProblemResponses, buildOpenApiDocument } from './swagger.js';

@Controller('things')
class ThingsController {
  @Get()
  @ApiOkResponse({ description: 'ok' })
  @ApiProblemResponses(401, 404)
  list() {
    return [];
  }
}

describe('buildOpenApiDocument', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('documents errors as problem+json, bearer auth and the Kong server', () => {
    const document = buildOpenApiDocument(app, {
      title: 'Test',
      description: 'd',
      servers: [['http://localhost:3999', 'local']],
    });

    expect(document.servers?.map((server) => server.url)).toEqual(['http://localhost:8000', 'http://localhost:3999']);
    expect(document.components?.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(document.components?.schemas?.ProblemDetailsDto).toBeDefined();
    expect(document.paths['/things'].get?.responses['404']).toEqual({
      description: 'Resource not found (or not visible to the caller)',
      content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' } } },
    });
  });
});
