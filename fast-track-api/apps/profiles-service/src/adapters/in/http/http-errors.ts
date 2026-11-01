/**
 * Translates use-case errors (application/errors.ts) into HTTP problems
 * (spec 2: application/problem+json). Anything else is rethrown untouched and
 * becomes a 500 in `ProblemDetailsFilter`.
 */
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { problem } from '@libs/http';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../../../application/errors.js';

export function toHttpError(error: unknown): unknown {
  if (error instanceof NotFoundError)
    return new NotFoundException(error.message);
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
