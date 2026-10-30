import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, extractToken, RequireRoles } from './auth.guard.js';
import { decodeJwtPayload, Roles, toAuthenticatedUser, type AuthenticatedUser } from './authenticated-user.js';

/** Builds an unsigned JWT; the guard never checks the signature (Kong does). */
function jwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const customerToken = jwt({ sub: 'customer-1', realm_access: { roles: ['CUSTOMER', 'offline_access'] } });

class FakeController {
  @RequireRoles(Roles.CUSTOMER)
  customerOnly() {}

  anyUser() {}
}

function contextFor(request: Record<string, unknown>, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

describe('toAuthenticatedUser', () => {
  it('reads sub and keeps only FastTrack roles', () => {
    expect(toAuthenticatedUser(decodeJwtPayload(customerToken))).toEqual({
      userId: 'customer-1',
      roles: ['CUSTOMER'],
    });
  });

  it('rejects a token without sub', () => {
    expect(() => toAuthenticatedUser(decodeJwtPayload(jwt({})))).toThrow(/sub/);
  });

  it('rejects something that is not a JWT', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow(/not a JWT/);
  });
});

describe('extractToken', () => {
  it('reads the Authorization header', () => {
    expect(extractToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
  });

  it('falls back to the ?jwt= query parameter (SSE)', () => {
    expect(extractToken({ headers: {}, query: { jwt: 'abc' } })).toBe('abc');
  });
});

describe('AuthGuard', () => {
  const guard = new AuthGuard(new Reflector());
  const handlers = new FakeController();

  it('returns 401 without a token', () => {
    expect(() => guard.canActivate(contextFor({ headers: {} }, handlers.anyUser))).toThrow(UnauthorizedException);
  });

  it('returns 401 with a malformed token', () => {
    const request = { headers: { authorization: 'Bearer nope' } };
    expect(() => guard.canActivate(contextFor(request, handlers.anyUser))).toThrow(UnauthorizedException);
  });

  it('stores the user on the request when the role matches', () => {
    const request: { headers: object; user?: AuthenticatedUser } = {
      headers: { authorization: `Bearer ${customerToken}` },
    };

    expect(guard.canActivate(contextFor(request, handlers.customerOnly))).toBe(true);
    expect(request.user).toEqual({ userId: 'customer-1', roles: ['CUSTOMER'] });
  });

  it('returns 403 when the caller lacks the required role', () => {
    const driverToken = jwt({ sub: 'driver-1', realm_access: { roles: ['DRIVER'] } });
    const request = { headers: { authorization: `Bearer ${driverToken}` } };

    expect(() => guard.canActivate(contextFor(request, handlers.customerOnly))).toThrow(ForbiddenException);
  });

  it('lets any authenticated user through when no role is required', () => {
    const request = { headers: { authorization: `Bearer ${customerToken}` } };

    expect(guard.canActivate(contextFor(request, handlers.anyUser))).toBe(true);
  });
});
