/**
 * Problem Details (RFC 7807): the error body of every FastTrack service.
 *
 * Why it exists
 * -------------
 * docs/spec.md section 2 says every error is `application/problem+json` with
 * the fields `type`, `title`, `status`, `detail`, `instance`, `correlationId`
 * and, for validation errors, `errors: [{ field, message }]`. Nest's default
 * error body has another shape, so this file provides:
 *
 * - `ProblemDetailsFilter`: a global exception filter that turns ANY thrown
 *   error into that body (unexpected errors become a generic 500, without
 *   leaking internals).
 * - `createValidationPipe()`: Nest's ValidationPipe configured so invalid
 *   request bodies produce `400` with the `errors` list.
 * - `problem()`: a helper to throw a specific problem from a controller.
 *
 * Usage in main.ts:
 *   app.useGlobalFilters(new ProblemDetailsFilter());
 *   app.useGlobalPipes(createValidationPipe());
 */
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';

/** Base URI of the `type` field, as in the spec example. */
export const PROBLEM_TYPE_BASE = 'https://api.fasttrack.local/errors';

/** One invalid field of a request (spec: `errors: [{ field, message }]`). */
export interface FieldError {
  field: string;
  message: string;
}

/** The body sent to the client. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  correlationId?: string;
  errors?: FieldError[];
}

/** What a thrown HttpException may carry to customise the problem. */
interface ProblemOverrides {
  /** Last segment of the `type` URI, e.g. `invalid-transition`. */
  type?: string;
  title?: string;
  detail?: string;
  errors?: FieldError[];
}

/** Default `type` slug per status code. */
const DEFAULT_TYPES: Partial<Record<number, string>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  429: 'rate-limited',
  500: 'internal',
  503: 'unavailable',
};

/**
 * Builds an HttpException that the filter renders as the given problem.
 *
 * @example throw problem(409, { type: 'invalid-transition', title: 'Invalid transition', detail: '...' })
 */
export function problem(status: number, overrides: ProblemOverrides = {}): HttpException {
  return new HttpException(overrides, status);
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  /** Converts any exception into a Problem Details response. */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const body = this.toProblem(exception, request);
    if (body.status >= 500) {
      // Log the real cause; the client only gets a generic message.
      this.logger.error(
        { msg: 'Unhandled error', instance: body.instance, correlationId: body.correlationId },
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(body.status).type('application/problem+json').json(body);
  }

  private toProblem(exception: unknown, request: Request): ProblemDetails {
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const overrides = exception instanceof HttpException ? readOverrides(exception) : {};

    return {
      type: `${PROBLEM_TYPE_BASE}/${overrides.type ?? DEFAULT_TYPES[status] ?? 'error'}`,
      title: overrides.title ?? STATUS_CODES[status] ?? 'Error',
      status,
      detail: status >= 500 ? 'An unexpected error occurred.' : overrides.detail,
      instance: request.originalUrl ?? request.url,
      correlationId: headerValue(request.headers['x-correlation-id']),
      errors: overrides.errors,
    };
  }
}

/**
 * Reads the customisation from an HttpException. Nest's built-in exceptions
 * (e.g. `new NotFoundException('Order not found')`) carry `{ message, error }`;
 * exceptions built with {@link problem} carry {@link ProblemOverrides}.
 */
function readOverrides(exception: HttpException): ProblemOverrides {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return { detail: response };
  }
  const body = response as Record<string, unknown>;
  const message = body.message;
  return {
    type: typeof body.type === 'string' ? body.type : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    detail:
      typeof body.detail === 'string' ? body.detail : typeof message === 'string' ? message : undefined,
    errors: Array.isArray(body.errors) ? (body.errors as FieldError[]) : undefined,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Flattens class-validator errors into `[{ field, message }]`. Nested objects
 * produce dotted paths (`points.3.lat`).
 */
export function toFieldErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...toFieldErrors(error.children ?? [], field)];
  });
}

/**
 * ValidationPipe for request bodies, query and params:
 * - `whitelist` + `forbidNonWhitelisted`: unknown fields are rejected, so a
 *   client cannot sneak in properties such as `customerId` (spec 2, Identity).
 * - `transform`: the controller receives an instance of the DTO class.
 * - invalid input -> 400 problem with the `errors` list.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        type: 'validation',
        title: 'Invalid request',
        detail: 'One or more fields are invalid.',
        errors: toFieldErrors(errors),
      }),
  });
}
