export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    message: string,
    readonly errors?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'ProblemError';
  }
}

export function validationError(
  detail: string,
  field: string,
): ProblemError {
  return new ProblemError(
    400,
    'validation',
    'Invalid request',
    detail,
    [{ field, message: detail }],
  );
}
