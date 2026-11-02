import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ProblemError } from '../application/problem-error.js';

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const correlationId = request.header('x-correlation-id') ?? randomUUID();

    if (exception instanceof ProblemError) {
      response
        .status(exception.status)
        .type('application/problem+json')
        .json({
          type: `https://api.fasttrack.local/errors/${exception.type}`,
          title: exception.title,
          status: exception.status,
          detail: exception.message,
          instance: request.originalUrl,
          correlationId,
          ...(exception.errors ? { errors: exception.errors } : {}),
        });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const title =
        status === 401
          ? 'Unauthorized'
          : status === 403
            ? 'Forbidden'
            : 'Request failed';
      response.status(status).type('application/problem+json').json({
        type: `https://api.fasttrack.local/errors/http-${status}`,
        title,
        status,
        detail: exception.message,
        instance: request.originalUrl,
        correlationId,
      });
      return;
    }

    this.logger.error(
      'Unexpected Orders Service error',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(500).type('application/problem+json').json({
      type: 'https://api.fasttrack.local/errors/internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: request.originalUrl,
      correlationId,
    });
  }
}
