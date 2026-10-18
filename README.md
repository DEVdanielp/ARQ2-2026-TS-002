# ARQ2-2026-TS-002

## Caso Asignado

**Case 2: FastTrack - Last-Mile Logistics**

## Integrantes

- Daniel Palacios
- Manuela Gomez
- Andres Restrepo
- Samuel Castaño
- Miguel Arango

## Problematic Scenario

FastTrack is a delivery app. Its current architecture forces the customer to compulsively refresh the app every 3 seconds to know where their package is. This generates a massive internal DDoS attack, as the frontend makes synchronous REST requests that execute heavy JOIN operations in PostgreSQL to cross-reference orders, drivers, and locations. Additionally, drivers move through tunnels or areas without signal; when they lose connection, their mobile app accumulates coordinates and, upon reconnecting, fires a massive array of 50 GPS locations at once in a single request (each coordinate carries the device timestamp and a sequence number). The current backend processes them out of order due to concurrency issues, causing a package to jump from "Delivered" back to "On the Way", corrupting the logical audit sequence.

## 5 Mandatory Features

1. Profile management and order-to-driver assignment (Customer and Driver).
2. Asynchronous ingestion of GPS coordinates ensuring strictly sequential processing.
3. Optimized current order status query, designed to absorb high read demand without hitting relational databases.
4. Engine that processes order state transitions (Created -> On the Way -> Delivered) driven exclusively by events, including Cancelled as a terminal state (by the customer only while Created; by operations staff, with a reason, while On the Way).
5. Proactive notification system (push/email) informing the final customer of package proximity.

## Documentación

- [Especificación (spec.md)](docs/spec.md)
- [ADRs](docs/adrs/)
- [C1 - Context](docs/assets/C1-Context.drawio.png)
- [C2 - Containers](docs/assets/C2-Containers.drawio.png)

Link TS-002 Google Docs: <!-- TODO: pegar link -->
