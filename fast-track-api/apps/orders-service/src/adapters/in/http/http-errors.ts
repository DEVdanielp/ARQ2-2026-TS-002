/**
 * Translates use-case errors (application/errors.ts) into HTTP problems
 * (spec 2: application/problem+json). Anything else is rethrown untouched and
 * becomes a 500 in `ProblemDetailsFilter`.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { problem } from '@libs/http';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../application/errors.js';

export function toHttpError(error: unknown): unknown {
  if (error instanceof NotFoundError)
    return new NotFoundException(error.message);
  if (error instanceof ForbiddenError)
    return new ForbiddenException(error.message);
  if (error instanceof ConflictError)
    return problem(409, {
      type: error.code,
      title: error.title,
      detail: error.message,
    });
  if (error instanceof InvalidInputError) {
    return problem(400, {
      type: 'validation',
      title: 'Invalid request',
      detail: 'One or more fields are invalid.',
      errors: [{ field: error.field, message: error.message }],
    });
  }
  if (error instanceof ServiceUnavailableError) {
    return problem(503, {
      title: 'Service temporarily unavailable',
      detail: error.message,
    });
  }
  return error;
}

/** Runs a use case and rethrows its errors as HTTP problems. */
export async function asHttp<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHttpError(error);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Correlation id for the events a request publishes (spec 2, Correlation):
 * the `X-Correlation-Id` Kong adds, or a new UUID when the service is called
 * directly or the header is not a UUID (`EventEnvelope.correlationId` is one).
 */
export function correlationIdFrom(header: string | undefined): string {
  return header && UUID.test(header) ? header : randomUUID();
}

/** The `Idempotency-Key` header, which must be a UUID when present (spec 2). */
export function idempotencyKeyFrom(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  if (UUID.test(header)) return header.toLowerCase();
  throw problem(400, {
    type: 'validation',
    title: 'Invalid request',
    detail: 'One or more fields are invalid.',
    errors: [{ field: 'Idempotency-Key', message: 'must be a UUID' }],
  });
}
