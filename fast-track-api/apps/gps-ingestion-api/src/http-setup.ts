/**
 * HTTP settings of the GPS Ingestion API, shared by main.ts and the tests so
 * the tests exercise exactly what runs in production.
 *
 * Create the app with `{ bodyParser: false }` so the JSON parser below, with
 * its size limit, is the only one.
 */
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createValidationPipe, problem, ProblemDetailsFilter } from '@libs/http';

/**
 * Largest accepted request body. 50 points take about 8 KB of JSON (16 KB
 * pretty-printed), so 64 KB leaves room while rejecting abuse early with 413
 * (spec 4.3) before any parsing or validation work.
 */
export const MAX_BODY_SIZE = '64kb';

/**
 * ProblemDetailsFilter that also understands the "body too large" error of
 * Express's body parser. It is not an HttpException, so the base filter would
 * answer 500. (Malformed JSON already arrives as a 400 BadRequestException.)
 */
@Catch()
export class IngestionProblemFilter extends ProblemDetailsFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(isBodyTooLarge(exception) ? problem(413, { detail: `The body exceeds ${MAX_BODY_SIZE}.` }) : exception, host);
  }
}

function isBodyTooLarge(exception: unknown): boolean {
  return (
    !(exception instanceof HttpException) &&
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { type?: unknown }).type === 'entity.too.large'
  );
}

export function configureHttp(app: NestExpressApplication): void {
  // Kong forwards the full path, /v1 included (strip_path: false in deploy/kong/kong.yml).
  app.setGlobalPrefix('v1');
  // Too-large bodies fail inside the parser with status 413; the filter below
  // turns that error into a problem+json like every other error.
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  // Every error leaves as application/problem+json (spec 2).
  app.useGlobalFilters(new IngestionProblemFilter());
  // Validates the body against PointBatchDto; invalid or unknown fields -> 400.
  app.useGlobalPipes(createValidationPipe());
}
