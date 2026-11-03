/**
 * Errors of the Maps/ETA provider adapters, and the HTTP call they share.
 *
 * Every failure of a provider becomes an EtaProviderError with a `kind`, so
 * the use case can keep falling back to distance (ADR-013) while the logs and
 * the ResilientEtaProvider can tell a bad API key from a busy provider.
 */

export type EtaProviderErrorKind =
  /** No answer within ETA_TIMEOUT_MS. */
  | 'TIMEOUT'
  /** DNS, connection refused, TLS...: the provider could not be reached. */
  | 'NETWORK'
  /** 401/403: missing or invalid API key. Retrying will not help. */
  | 'AUTH'
  /** 429, or the local quota guard: the free quota is used up for now. */
  | 'QUOTA'
  /** The provider answered, but there is no route between the points (e.g. a point far from any road). */
  | 'NO_ROUTE'
  /** 2xx with a body we cannot read. */
  | 'INVALID_RESPONSE'
  /** 5xx, or another unexpected status. */
  | 'UNAVAILABLE';

export class EtaProviderError extends Error {
  constructor(
    readonly kind: EtaProviderErrorKind,
    readonly provider: string,
    message: string,
    /** HTTP status, when there was a response. */
    readonly status?: number,
  ) {
    super(`${provider} ${kind}: ${message}`);
    this.name = 'EtaProviderError';
  }
}

/** Maps an HTTP error status to a kind. */
export function kindForStatus(status: number): EtaProviderErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'QUOTA';
  return 'UNAVAILABLE';
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON, or undefined if the body was not JSON. */
  body: unknown;
}

/**
 * One HTTP call with a hard timeout. Network failures and timeouts become
 * EtaProviderError; HTTP error statuses are returned to the caller, which
 * knows how its provider reports errors in the body.
 */
export async function requestJson(provider: string, url: URL, init: RequestInit, timeoutMs: number): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new EtaProviderError('TIMEOUT', provider, `no answer after ${timeoutMs} ms`);
    }
    throw new EtaProviderError('NETWORK', provider, error instanceof Error ? error.message : String(error));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, ok: response.ok, body };
}

/** A finite, non-negative number, or undefined. */
export function asSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
