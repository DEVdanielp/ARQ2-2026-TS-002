/**
 * Who is calling: the identity every service reads from the request's JWT.
 *
 * Why it exists
 * -------------
 * Keycloak issues the token and Kong verifies it (signature and expiry) before
 * the request reaches any service (ADR-007, ADR-008). Kong then forwards the
 * request with the same `Authorization: Bearer <JWT>` header. Kong does NOT
 * check roles: deploy/kong/kong.yml says "Role checks (CUSTOMER/DRIVER/
 * OPERATIONS -> 403) are done inside each service". So every service needs to
 * read the token's claims, and this file does it in one place.
 *
 * Trust model
 * -----------
 * We DECODE the token here, we do not VERIFY its signature again: Kong already
 * did. This is safe only because the services are not reachable from outside
 * the Docker network (docker-compose.yml publishes no host port for them), so
 * every external request goes through Kong. If a service is ever exposed
 * directly, it must verify the signature too (for example against Keycloak's
 * JWKS endpoint).
 */

/** Realm roles defined in Keycloak (spec section 2, Authentication). */
export const Roles = {
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  OPERATIONS: 'OPERATIONS',
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

const KNOWN_ROLES = new Set<string>(Object.values(Roles));

/** The caller, as seen by a service. */
export interface AuthenticatedUser {
  /**
   * The JWT `sub` claim: the user id. For "me" endpoints this is the ONLY
   * source of the user id; services never accept it in the body (spec 2,
   * Identity).
   */
  userId: string;
  /** FastTrack roles found in `realm_access.roles`; other Keycloak roles are dropped. */
  roles: Role[];
}

/** The token is missing or cannot be read. Mapped to HTTP 401. */
export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Decodes the payload (middle part) of a JWT without verifying it.
 * A JWT is `header.payload.signature`, each part base64url-encoded JSON.
 *
 * @throws {InvalidTokenError} if the token is not a well-formed JWT.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new InvalidTokenError('Token is not a JWT');
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('payload is not an object');
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new InvalidTokenError(`Token payload is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Builds the {@link AuthenticatedUser} from a decoded JWT payload.
 *
 * @throws {InvalidTokenError} if the token has no `sub`.
 */
export function toAuthenticatedUser(payload: Record<string, unknown>): AuthenticatedUser {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new InvalidTokenError('Token has no "sub" claim');
  }

  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const rawRoles = Array.isArray(realmAccess?.roles) ? realmAccess.roles : [];
  const roles = rawRoles.filter((role): role is Role => typeof role === 'string' && KNOWN_ROLES.has(role));

  return { userId: sub, roles };
}
