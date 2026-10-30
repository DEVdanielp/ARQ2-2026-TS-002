/**
 * AuthGuard and decorators: authentication and role checks for controllers.
 *
 * Usage
 * -----
 *   @Controller('notifications')
 *   @UseGuards(AuthGuard)
 *   export class PreferencesController {
 *     @Get('preferences')
 *     @RequireRoles(Roles.CUSTOMER)
 *     get(@CurrentUser() user: AuthenticatedUser) { ... user.userId ... }
 *   }
 *
 * - No token or unreadable token      -> 401 Unauthorized
 * - Token without any required role   -> 403 Forbidden (spec 2, Common status codes)
 * - No @RequireRoles on the route     -> any authenticated user may call it
 */
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  decodeJwtPayload,
  InvalidTokenError,
  toAuthenticatedUser,
  type AuthenticatedUser,
  type Role,
} from './authenticated-user.js';

const ROLES_KEY = 'fasttrack:roles';

/** The parts of an HTTP request the guard reads (Express-compatible). */
interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  user?: AuthenticatedUser;
}

/**
 * Restricts a route (or every route of a controller) to callers that have at
 * least ONE of the given roles.
 */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the {@link AuthenticatedUser} set by {@link AuthGuard}. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<AuthRequest>().user,
);

/**
 * Reads the bearer token from the `Authorization` header or, for SSE (the
 * browser's EventSource cannot send headers), from the `?jwt=` query parameter,
 * which Kong also accepts (deploy/kong/kong.yml, `uri_param_names`).
 */
export function extractToken(request: AuthRequest): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value?.startsWith('Bearer ')) {
    return value.slice('Bearer '.length).trim() || undefined;
  }
  const fromQuery = request.query?.jwt;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : undefined;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /** Authenticates the request, stores the user on it and checks the roles. */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();

    const token = extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let user: AuthenticatedUser;
    try {
      user = toAuthenticatedUser(decodeJwtPayload(token));
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }
    request.user = user;

    // Route-level roles override controller-level roles.
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException(`Requires one of the roles: ${required.join(', ')}`);
    }
    return true;
  }
}
