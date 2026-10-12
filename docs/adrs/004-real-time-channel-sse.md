# ADR-004: Real-time updates to the customer with SSE

- **Status:** Proposed
- **Features:** F3
- **Containers involved:** Customer App, API Gateway, Tracking Query Service, tracking-cache

## Context and Problem

The customer app must see status and location changes without polling every 3 seconds. Traffic is one-directional (server → client). Several Tracking Query instances run behind the gateway, so a change processed by one instance must reach clients connected to another.

## Considered Alternatives

1. Short polling against the read model (every N seconds).
2. WebSocket connections through the gateway.
3. Server-Sent Events (SSE) through the gateway, with Redis Pub/Sub to fan out changes across instances.

## Decision

Use SSE. The app loads the view once over REST and then keeps an SSE stream. When `ProjectEventHandler` writes a view, `ChangeNotifier` publishes the order id on Redis Pub/Sub; every instance holding a stream for that order pushes the new view.

## Trade-offs

### Positives (what we gain)

- Plain HTTP: works through Kong, proxies and load balancers; automatic reconnection (`Last-Event-ID`).
- Simpler than WebSocket for one-way traffic.
- Removes the 3-second polling load completely.

### Negatives (risks / what we lose)

- One open connection per watching customer. *Mitigation:* idle timeout and heartbeats; scale Tracking Query horizontally.
- Redis Pub/Sub is fire-and-forget: a missed message is not replayed. *Mitigation:* on reconnection the client reloads the view over REST.
- Gateway must not buffer responses. *Mitigation:* SSE proxy configured without buffering in Kong.

## Final Justification

The channel only needs server-to-client updates; SSE gives that with less infrastructure than WebSocket and without polling.
