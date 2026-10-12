# ADR-001: Sequential GPS ingestion with Kafka partitioned by driver

- **Status:** Accepted
- **Features:** F2
- **Containers involved:** GPS Ingestion API, GPS Tracking Worker, Kafka

## Context and Problem

When a driver reconnects after losing signal, the app sends up to 50 GPS points in a single request, each with a device timestamp and a sequence number. The current backend processes them concurrently and out of order, corrupting the location and the audit trail. Points must be processed strictly in order per driver without blocking the driver app.

## Considered Alternatives

1. Process the batch synchronously inside the REST request with a database lock per driver.
2. RabbitMQ with one queue per driver (or a single active consumer per queue).
3. Kafka topic partitioned by `driverId`, with ordering and deduplication by sequence number in the consumer.

## Decision

The GPS Ingestion API validates the batch, publishes `GpsBatchReceived` to `gps.batches` with `driverId` as the key and returns `202 Accepted`. The GPS Tracking Worker consumes each partition with a single consumer, sorts by sequence, ignores sequences already processed, appends to the history and advances the location only with a higher sequence.

## Trade-offs

### Positives (what we gain)

- Ordering per driver is guaranteed by the partition, not by locks.
- Horizontal scaling by adding partitions and consumers.
- The driver app gets an immediate `202`; peaks are absorbed by the broker.
- Events can be replayed to rebuild state or for audits.

### Negatives (risks / what we lose)

- Operating a Kafka cluster adds complexity. *Mitigation:* KRaft mode (no ZooKeeper), one cluster for all topics.
- At-least-once delivery produces duplicates. *Mitigation:* idempotency on `(driverId, sequence)`.
- The partition count is fixed up front and reshuffles keys if changed. *Mitigation:* start with 24 partitions, sized for the expected active drivers.
- A very active driver can create a hot partition. *Mitigation:* monitor consumer lag per partition.

## Final Justification

The ordering requirement is per driver, which maps exactly to a Kafka partition key. Synchronous processing blocks the app and does not scale; a queue per driver multiplies broker resources.
