# @libs/auth

Who is calling, and may they do this? Shared by every service.

Kong verifies the JWT issued by Keycloak (signature and expiry) and forwards it
unchanged. **Kong does not check roles**: each service does, with this library.

## Usage

```ts
import { AuthGuard, CurrentUser, RequireRoles, Roles, type AuthenticatedUser } from '@libs/auth';

@Controller('notifications')
@UseGuards(AuthGuard)
export class PreferencesController {
  @Get('preferences')
  @RequireRoles(Roles.CUSTOMER)
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.getPreferences.execute(user.userId); // never take the user id from the body
  }
}
```

| Situation | Result |
| --- | --- |
| No `Authorization: Bearer` header (and no `?jwt=` for SSE) | `401` |
| Token is not a readable JWT or has no `sub` | `401` |
| `@RequireRoles(...)` and the caller has none of those roles | `403` |
| No `@RequireRoles` | any authenticated user |

`AuthenticatedUser` = `{ userId }` (the JWT `sub`) + `{ roles }` (FastTrack roles
from `realm_access.roles`: `CUSTOMER`, `DRIVER`, `OPERATIONS`).

## Trust model

The token is **decoded, not re-verified**: Kong already verified it. This is safe
only because the services publish no host ports (`docker-compose.yml`), so every
external request goes through Kong. A service exposed directly would have to
verify the signature itself (Keycloak JWKS).
