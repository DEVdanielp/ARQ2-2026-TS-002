# ADR-020: openrouteservice as the free Maps/ETA provider

- **Status:** Accepted
- **Features:** F5 (NEARBY), F2
- **Containers involved:** GPS Tracking Worker, Maps/ETA Provider (external)
- **Related:** ADR-013 (when the ETA is asked), ADR-018 (provider contract left open), ADR-012 (failures never block)

## Context

The NEARBY rule (spec §5.4, F5-S1) fires when the driver is within 500 m of the destination **or the ETA is under 5 minutes**. Straight-line distance is computed locally. The ETA needs a routing engine on a real road network. The spec lists a **Maps/ETA Provider** as an external system (§1, C1/C2) but does not choose one.

ADR-013 already bounds the calls. The worker asks only within 3 km of the destination, at most once per minute per order, with a short timeout, and falls back to distance on any failure. ADR-018 left the provider open behind the `EtaProvider` port and a generic HTTP contract. The only consumer is the GPS Tracking Worker (`ProcessGpsBatch`). No other service and no REST endpoint uses maps or ETA.

## Problem

Choose a provider that:

1. computes driving **duration (ETA)** and distance between two coordinates, worldwide and in Colombia;
2. is **free** for this project's volume, with no paid subscription and no trial that expires;
3. fits the architecture: plain HTTPS/JSON called from Node 24 `fetch` (no SDK, no new dependency), secrets only in environment variables, and failures that can be mapped to the distance fallback.

**Volume estimate.** ADR-013 allows at most one call per order per minute, only during the last ~3 km, which is a few minutes per order. Say 3–5 calls per delivered order. Up to 400–600 deliveries a day fit in 2 000 calls a day. The per-minute peak is bounded by the number of orders inside the 3 km ring at the same time.

## Alternatives evaluated

Conditions checked on 2026-11-02 against the providers' official pages and live calls (see "Verification").

| Provider | Free modality | Free limits (routing) | Key / card | Commercial use (free tier) | Fit |
| --- | --- | --- | --- | --- | --- |
| **openrouteservice (HeiGIT)** | Permanent "Standard" plan, "free for everyone" | Directions V2: **2 000 / day, 40 / min** | Free API key, **no card** | Not restricted for Standard in what we found (to re-check, see below) | JSON REST, OSM data, Colombia covered, self-hostable (open source) |
| OSRM public demo server | Free, no account | ~**1 request/s**, "reasonable" use, no SLA | No key | **Non-commercial only** | JSON REST, OSM data; demo only. Same API self-hosted |
| OSRM / Valhalla self-hosted | Free software (BSD/MIT) | Unlimited (own hardware) | None | Yes | Adds a container plus OSM extract preprocessing and RAM; ops cost for the team |
| GraphHopper Directions API | "Free" plan, 0 € | **500 credits / day**; per-minute limit not published | Account | **Non-commercial only** | Good API, but the quota is 4× smaller and the use is restricted |
| Mapbox Directions | Pay-as-you-go with a monthly free tier | ~100 000 / month | **Payment card** for the free tier; card-free trial capped at 10 000 requests | Yes | Good, but needs a card, against the "free" constraint |
| Google Maps Routes API | Monthly free usage caps | Per SKU | **Billing account with payment method** | Yes | Excluded: needs billing |

## Decision

**openrouteservice (HeiGIT), Standard plan**, is the Maps/ETA provider of FastTrack. The worker implements it as an outbound adapter of the existing `EtaProvider` port (ADR-014):

- `OpenRouteServiceEtaProvider`:
  - Request: `POST https://api.heigit.org/openrouteservice/v2/directions/{profile}` with header `Authorization: <ORS_API_KEY>` and body `{ coordinates: [[lng,lat],[lng,lat]], instructions: false, geometry: false }`.
  - Response: `routes[0].summary.duration` (seconds; `distance` in metres).
  - Default profile `driving-car`.
- **Host:** `api.heigit.org`. The former host `api.openrouteservice.org` is deprecated. It has had only 10 % of the quota since 2026-08-27 and is being shut down on 2026-11-02/06.
- **OSRM** (`OsrmEtaProvider`) is kept as a **keyless option for local development and demos** (public demo server, non-commercial, 1 req/s) and for a future self-hosted OSRM. It is never the production default.
- The generic `http` contract of ADR-018 and the distance-only mode stay available. **The port, the NEARBY rule, the events and every existing contract are unchanged.**

Selection (`ETA_PROVIDER`):

| Value | Behaviour |
| --- | --- |
| `openrouteservice` | Selected provider. Requires `ORS_API_KEY` (startup fails without it). |
| `osrm` | Keyless OSRM (development, demo). |
| `http` | ADR-018 generic contract at `ETA_PROVIDER_URL`. |
| `none` | Distance only. |
| empty | Backwards compatible: `ORS_API_KEY` set selects `openrouteservice`; else `ETA_PROVIDER_URL` set selects `http`; else `none`. |

**Staying inside the free plan.** Every real provider is wrapped in `ResilientEtaProvider`:

- **Local quota guard.** Defaults: openrouteservice **40 / min and 2 000 / 24 h**, OSRM 60 / min. They can be overridden with `ETA_RATE_LIMIT_PER_MINUTE` and `ETA_DAILY_QUOTA`. Over the limit, the call is not made.
- **Cool-down.** After `401/403` (bad key) the provider is skipped for 10 minutes. After `429` it is skipped for 60 seconds.

**Error handling.** Every failure becomes an `EtaProviderError` with a kind: `TIMEOUT`, `NETWORK`, `AUTH`, `QUOTA`, `NO_ROUTE` (ORS codes 2004/2009/2010, OSRM `NoRoute`/`NoSegment`), `INVALID_RESPONSE` or `UNAVAILABLE`. `ProcessGpsBatch` already catches any provider error, logs it, records the ETA check (so the throttle applies) and continues with distance (ADR-013). A provider failure never fails, retries or blocks a GPS batch.

**Secrets.** `ORS_API_KEY` is read only from the environment: `.env` is git-ignored, and docker-compose passes `${ORS_API_KEY}` from the host. The key is sent in a header, never in the URL, and is never logged.

## Confirmation of the free modality and its limits

- The **openrouteservice Standard plan** is described by HeiGIT as free for everyone. A key is obtained by signing up at openrouteservice.org; no payment method is needed.
- Directions V2: **2 000 requests per day and 40 per minute**. Quota usage is visible in the developer dashboard. Secondary sources say the daily quota resets on a rolling 24 h basis, which is why the local guard also uses a rolling 24 h window.
- Other endpoints (matrix, isochrones, geocoding) have their own quotas; FastTrack does not use them.
- **Attribution.** Results are based on OpenStreetMap (ODbL). Any map or route shown to users must credit "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors".
- **To re-check before a commercial launch:** HeiGIT's terms for commercial use of the Standard plan. We found no restriction, but could not read the terms page in full. The OSRM demo server is explicitly **non-commercial**, which is why it is only a development option.

**Verification (2026-11-02).**

- **openrouteservice:** `api.heigit.org/openrouteservice/v2/directions/driving-car` was reached live. It answers 401 "Authorization field missing" without a key, and an invalid key is rejected and classified as `AUTH`.
- **OSRM demo:** returned real routes in Medellín (e.g. 244 s for ~2 km). Through the real `ProcessGpsBatch` it fired NEARBY with trigger `ETA` from a point 1 km away.
- **Not verified:** a real openrouteservice route needs a team API key. The live test runs automatically when `ORS_API_KEY` is set (`apps/gps-tracking-worker/test/eta-providers.e2e-spec.ts`).

## Advantages and disadvantages

### Advantages

- Free and permanent, without a payment card. The quota covers the expected volume thanks to ADR-013's throttling.
- Same open data (OSM) and HTTP style as OSRM, and openrouteservice is open source: the team can self-host the same API by setting `ETA_PROVIDER_URL`, without code changes.
- No new dependency (built-in `fetch`), no new container, no change to contracts or other services.

### Disadvantages

- **External dependency with no SLA** on a free plan. *Mitigation:* 2 s timeout, quota guard, cool-down and distance fallback; NEARBY still works by distance.
- **Hard daily cap (2 000).** Beyond it, ETA-based NEARBY degrades to distance until the window frees. *Mitigation:* the local guard stops before the provider's 429; dashboard monitoring.
- **Per-process counters.** With N worker instances the effective budget is N times the configured one. *Mitigation:* set `ETA_RATE_LIMIT_PER_MINUTE` and `ETA_DAILY_QUOTA` to the budget divided by N (the outbox README already recommends one instance per service).
- **Routing profile.** OSM-based car ETAs ignore live traffic, and there is no motorcycle profile. *Mitigation:* the ETA only decides an early NEARBY; the profile is configurable (`ETA_ROUTING_PROFILE`).
- **Host migration risk** (as just happened with `api.openrouteservice.org`). *Mitigation:* the base URL is configurable (`ETA_PROVIDER_URL`).

## Architectural consequences

- The external **Maps/ETA Provider** of the C1/C2 diagrams is now concretely openrouteservice (HeiGIT), called only by the GPS Tracking Worker over HTTPS.
- New outbound adapters in `apps/gps-tracking-worker/src/adapters/out/eta/`: `OpenRouteServiceEtaProvider`, `OsrmEtaProvider`, `ResilientEtaProvider`, and shared errors. The application and domain layers are untouched (ADR-014).
- New environment variables, all optional except `ORS_API_KEY` when `ETA_PROVIDER=openrouteservice`: `ETA_PROVIDER`, `ORS_API_KEY`, `ETA_ROUTING_PROFILE`, `ETA_RATE_LIMIT_PER_MINUTE`, `ETA_DAILY_QUOTA`.
- ADR-018 point 6 (contract left open) is completed by this ADR. The generic contract stays as the `http` option.

## Scalability and future costs

- **Up to ~2 000 ETA calls a day** (a few hundred deliveries a day): €0.
- **Beyond that,** in order of preference:
  1. **Self-host openrouteservice or OSRM** with a Colombia OSM extract (Docker images exist, a few GB of RAM for one country). Cost: one small VM, no per-request fees, no quota. Switch with `ETA_PROVIDER_URL` (and `ETA_PROVIDER=osrm` for OSRM), with no code change.
  2. HeiGIT's higher plans (Collaborative, for non-profit and research partners) or a commercial agreement with HeiGIT.
  3. A paid provider (Mapbox, Google, TomTom) as another adapter of the same port. Per-request pricing (Mapbox ~US$2 per 1 000 above its free tier) multiplies with traffic, so ADR-013's throttling remains the main cost control.
- **If real-time traffic becomes a requirement,** only commercial providers offer it. That would be a new ADR, since it implies payment.
