# ADR-007: Identity provider: Keycloak

- **Status:** Proposed
- **Features:** F1 (all, as cross-cutting)
- **Containers involved:** Identity Provider, API Gateway, apps

## Context and Problem

Three apps (customer, driver, operations) need login, and every API call must carry the user's role. The rest of the stack is open source and self-hosted.

## Considered Alternatives

1. Managed provider (Auth0, Amazon Cognito).
2. Firebase Authentication (already using FCM).
3. Keycloak, self-hosted, OIDC.

## Decision

Use Keycloak with Authorization Code + PKCE for the apps. It issues RS256 JWTs with the role (`CUSTOMER`, `DRIVER`, `OPERATIONS`). Kong validates tokens with Keycloak's public keys (JWKS). Profiles stores business data linked by the token's `sub`.

## Trade-offs

### Positives (what we gain)

- Standard OIDC; no vendor lock-in; free; runs locally with the rest of the stack.
- Roles in the token let the gateway and services authorize without extra calls.

### Negatives (risks / what we lose)

- The team must operate it (database, upgrades, HA). *Mitigation:* single instance in Wave 1; HA plan for production.
- If Keycloak is down nobody can log in (existing tokens keep working until they expire).

## Final Justification

It covers the requirements with a self-hosted, standard component consistent with the rest of the stack. A managed provider should be re-evaluated for production with a small team.
