# ADR-008: API Gateway: Kong OSS (DB-less)

- **Status:** Accepted
- **Features:** F1–F5 (entry point)
- **Containers involved:** API Gateway

## context and Problem

All external traffic needs a single entry point that validates JWTs, limits requests per user, adds a correlation id, routes to six services and proxies SSE without buffering.

## Considered Alternatives

1. Spring Cloud Gateway (custom service).
2. NGINX / Envoy configured by hand.
3. Kong OSS in DB-less mode with declarative configuration.

## Decision

Use Kong OSS in DB-less mode, configured from a versioned YAML file, with the JWT, rate-limiting and correlation-id plugins.

## Trade-offs

### Positives (what we gain)

- Required features come as plugins; no custom code.
- Declarative config lives in the repository and is reviewed like code.
- Stateless: scales by adding instances behind a load balancer.

### Negatives (risks / what we lose)

- New tool for the team to learn.
- Rate-limiting counters are local per instance in DB-less mode. *Mitigation:* use the Redis policy for the rate-limiting plugin if exact limits are needed.

## Final Justification

It provides every required cross-cutting concern out of the box and keeps the configuration in version control.
