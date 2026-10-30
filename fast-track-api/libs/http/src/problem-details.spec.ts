import { Body, Controller, Get, INestApplication, NotFoundException, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsBoolean } from 'class-validator';
import request from 'supertest';
import { createValidationPipe, problem, ProblemDetailsFilter } from './problem-details.js';

class BodyDto {
  @IsBoolean()
  push: boolean;
}

@Controller('things')
class ThingsController {
  @Get('missing')
  missing() {
    throw new NotFoundException('Order not found');
  }

  @Get('conflict')
  conflict() {
    throw problem(409, { type: 'invalid-transition', title: 'Invalid transition', detail: 'Order is DELIVERED' });
  }

  @Get('boom')
  boom() {
    throw new Error('database password is hunter2');
  }

  @Post()
  create(@Body() body: BodyDto) {
    return body;
  }
}

describe('ProblemDetailsFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterAll(() => app.close());

  it('renders Nest exceptions as problem+json', async () => {
    const response = await request(app.getHttpServer())
      .get('/things/missing')
      .set('X-Correlation-Id', 'corr-1')
      .expect(404);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toEqual({
      type: 'https://api.fasttrack.local/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Order not found',
      instance: '/things/missing',
      correlationId: 'corr-1',
    });
  });

  it('honours a custom type and title', async () => {
    const response = await request(app.getHttpServer()).get('/things/conflict').expect(409);

    expect(response.body).toMatchObject({
      type: 'https://api.fasttrack.local/errors/invalid-transition',
      title: 'Invalid transition',
      detail: 'Order is DELIVERED',
    });
  });

  it('hides the cause of unexpected errors', async () => {
    const response = await request(app.getHttpServer()).get('/things/boom').expect(500);

    expect(response.body.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('lists invalid and unknown fields on validation errors', async () => {
    const response = await request(app.getHttpServer())
      .post('/things')
      .send({ push: 'yes', customerId: 'x' })
      .expect(400);

    expect(response.body.type).toBe('https://api.fasttrack.local/errors/validation');
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        { field: 'push', message: 'push must be a boolean value' },
        { field: 'customerId', message: 'property customerId should not exist' },
      ]),
    );
  });
});
