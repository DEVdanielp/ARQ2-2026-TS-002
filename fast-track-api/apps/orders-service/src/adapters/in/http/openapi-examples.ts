/**
 * Swagger helpers for this service: a documented error response with a
 * concrete problem+json example (the shared `ApiProblemResponses` documents
 * the schema; this adds what the error looks like for one endpoint).
 */
import type { ApiResponseOptions } from '@nestjs/swagger';

const CORRELATION_ID = '0b7d0c1e-3a55-4b8e-9d2b-5f0c2a9a7e11';

export interface ProblemExample {
  type: string;
  title: string;
  detail: string;
  instance: string;
  errors?: Array<{ field: string; message: string }>;
}

function asProblem(status: number, example: ProblemExample) {
  return {
    type: `https://api.fasttrack.local/errors/${example.type}`,
    title: example.title,
    status,
    detail: example.detail,
    instance: example.instance,
    correlationId: CORRELATION_ID,
    ...(example.errors && { errors: example.errors }),
  };
}

export function problemExample(
  status: number,
  description: string,
  example: ProblemExample,
): ApiResponseOptions {
  return problemExamples(status, description, { example });
}

/** The same, for a status with several causes: one named example per cause. */
export function problemExamples(
  status: number,
  description: string,
  examples: Record<string, ProblemExample>,
): ApiResponseOptions {
  return {
    status,
    description,
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ProblemDetailsDto' },
        examples: Object.fromEntries(
          Object.entries(examples).map(([name, example]) => [
            name,
            { value: asProblem(status, example) },
          ]),
        ),
      },
    },
  };
}
