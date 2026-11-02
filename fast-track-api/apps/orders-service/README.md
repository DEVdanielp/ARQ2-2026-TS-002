# Orders Service

The service needs PostgreSQL and Kafka to deliver its transactional outbox:

- `ORDERS_DATABASE_URL`: PostgreSQL connection string for the Orders database.
- `KAFKA_BROKERS`: comma-separated Kafka bootstrap servers, for example `kafka:9092`.
- `JWT_PUBLIC_KEY`: Keycloak RSA public key in PEM format.
- `KEYCLOAK_ISSUER`: expected Keycloak issuer URL.
- `KEYCLOAK_AUDIENCE`: optional token audience check.

Apply the SQL files in `orders-db/migrations` in numeric order before starting the
service. The outbox relay polls every 200 ms, publishes with the order id as the
Kafka key, and keeps failed events for retry. The intent consumer uses the
`orders-state-engine` group and sends messages that exhaust retries to
`orders.intents.dlq`.

Invalid business transitions are persisted as `IntentRejected` events in
`orders.events`, without changing the order status or version. Tracking Query
must consume this event to populate `TrackingView.lastRejectedIntent`; add this
event to the shared event catalog before integrating that consumer.
