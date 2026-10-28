#!/usr/bin/env bash
# Creates the topics defined in docs/spec.md §5.1. Safe to run many times.
set -euo pipefail

BOOTSTRAP="${BOOTSTRAP:-kafka:19092}"
KT=/opt/kafka/bin/kafka-topics.sh

create() { # name partitions
  "$KT" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
    --topic "$1" --partitions "$2" --replication-factor 1
}

# topic                 partitions   key          producer
create gps.batches          24     # driverId     GPS Ingestion API
create orders.intents       12     # orderId      Orders Service
create orders.events        12     # orderId      Orders Service
create assignment.events    12     # orderId      Profiles & Assignment
create profile.events        6     # customerId   Profiles & Assignment
create tracking.locations   12     # orderId      GPS Tracking Worker
create tracking.proximity   12     # orderId      GPS Tracking Worker
create notifications.retry   6     # orderId      Notification Service

# Dead-letter queues: one per source topic (ADR-012)
for t in gps.batches orders.intents orders.events assignment.events profile.events \
         tracking.locations tracking.proximity notifications.retry; do
  create "$t.dlq" 3
done

echo "Topics:"
"$KT" --bootstrap-server "$BOOTSTRAP" --list
