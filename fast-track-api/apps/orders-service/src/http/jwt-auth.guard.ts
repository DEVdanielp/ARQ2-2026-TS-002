import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verify } from 'node:crypto';
import { ProblemError } from '../application/problem-error.js';
import { isUuid, type AuthenticatedUser, type UserRole } from '../domain/order.js';

const VALID_ROLES: UserRole[] = ['CUSTOMER', 'DRIVER', 'OPERATIONS'];

interface JwtClaims {
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iss?: unknown;
  aud?: unknown;
  realm_access?: { roles?: unknown };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser }
    >();
    const authorization = request.header('authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) {
      throw new UnauthorizedException('A bearer token is required.');
    }

    const publicKey = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
    if (!publicKey) {
      throw new ProblemError(
        503,
        'authentication-unavailable',
        'Authentication unavailable',
        'JWT public key is not configured.',
      );
    }

    const [encodedHeader, encodedClaims, encodedSignature, extra] = match[1].split('.');
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) {
      throw new UnauthorizedException('Bearer token is malformed.');
    }

    let header: { alg?: unknown };
    let claims: JwtClaims;
    let signature: Buffer;
    try {
      header = JSON.parse(base64UrlToString(encodedHeader)) as { alg?: unknown };
      claims = JSON.parse(base64UrlToString(encodedClaims)) as JwtClaims;
      signature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw new UnauthorizedException('Bearer token is malformed.');
    }
    if (header.alg !== 'RS256') {
      throw new UnauthorizedException('Bearer token algorithm is not allowed.');
    }

    const signedContent = Buffer.from(`${encodedHeader}.${encodedClaims}`);
    let signatureIsValid: boolean;
    try {
      signatureIsValid = verify('RSA-SHA256', signedContent, publicKey, signature);
    } catch {
      throw new ProblemError(
        503,
        'authentication-unavailable',
        'Authentication unavailable',
        'JWT public key is invalid.',
      );
    }
    if (!signatureIsValid) {
      throw new UnauthorizedException('Bearer token signature is invalid.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.exp !== 'number' ||
      claims.exp <= now ||
      (typeof claims.nbf === 'number' && claims.nbf > now) ||
      !isUuid(claims.sub)
    ) {
      throw new UnauthorizedException('Bearer token claims are invalid or expired.');
    }

    const issuer = process.env.KEYCLOAK_ISSUER;
    if (!issuer) {
      throw new ProblemError(
        503,
        'authentication-unavailable',
        'Authentication unavailable',
        'Keycloak issuer is not configured.',
      );
    }
    if (claims.iss !== issuer) {
      throw new UnauthorizedException('Bearer token issuer is invalid.');
    }
    const audience = process.env.KEYCLOAK_AUDIENCE;
    if (
      audience &&
      !(claims.aud === audience ||
        (Array.isArray(claims.aud) && claims.aud.includes(audience)))
    ) {
      throw new UnauthorizedException('Bearer token audience is invalid.');
    }

    const roles = claims.realm_access?.roles;
    if (!Array.isArray(roles)) {
      throw new UnauthorizedException('Bearer token has no realm roles.');
    }
    request.user = {
      id: claims.sub,
      roles: roles.filter(
        (role): role is UserRole =>
          typeof role === 'string' && VALID_ROLES.includes(role as UserRole),
      ),
    };
    return true;
  }
}

function base64UrlToString(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}
