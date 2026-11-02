BEGIN;

CREATE TABLE orders (
    order_id UUID PRIMARY KEY,
    customer_id UUID NOT NULL,
    driver_id UUID,
    destination JSONB NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'ON_THE_WAY', 'DELIVERED', 'CANCELLED')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    cancellation_actor TEXT
        CHECK (cancellation_actor IN ('CUSTOMER', 'DRIVER', 'OPERATIONS', 'SYSTEM')),
    cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orders_destination_shape CHECK (
        jsonb_typeof(destination) = 'object'
        AND jsonb_typeof(destination->'location') = 'object'
        AND destination->>'address' IS NOT NULL
        AND char_length(destination->>'address') BETWEEN 1 AND 300
        AND destination->'location' ? 'lat'
        AND destination->'location' ? 'lng'
    ),
    CONSTRAINT orders_cancellation_fields CHECK (
        cancellation_reason IS NULL OR cancellation_actor IS NOT NULL
    ),
    CONSTRAINT operations_cancellation_requires_reason CHECK (
        cancellation_actor <> 'OPERATIONS'
        OR (cancellation_reason IS NOT NULL AND char_length(cancellation_reason) > 0)
    ),
    CONSTRAINT cancelled_orders_have_actor CHECK (
        status <> 'CANCELLED' OR cancellation_actor IS NOT NULL
    )
);

CREATE INDEX orders_customer_created_idx
    ON orders (customer_id, created_at DESC);
CREATE INDEX orders_driver_created_idx
    ON orders (driver_id, created_at DESC)
    WHERE driver_id IS NOT NULL;
CREATE INDEX orders_status_created_idx
    ON orders (status, created_at DESC);

CREATE TABLE processed_events (
    consumer_name TEXT NOT NULL,
    event_id UUID NOT NULL,
    topic TEXT NOT NULL,
    partition_number INTEGER,
    message_offset BIGINT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id),
    CONSTRAINT processed_events_partition_nonnegative CHECK (
        partition_number IS NULL OR partition_number >= 0
    ),
    CONSTRAINT processed_events_offset_nonnegative CHECK (
        message_offset IS NULL OR message_offset >= 0
    )
);

CREATE TABLE idempotency_keys (
    owner_id UUID NOT NULL,
    scope TEXT NOT NULL,
    idempotency_key UUID NOT NULL,
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    response_status SMALLINT NOT NULL CHECK (response_status BETWEEN 100 AND 599),
    response_body JSONB NOT NULL,
    response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner_id, scope, idempotency_key),
    CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expiry_idx
    ON idempotency_keys (expires_at);

CREATE TABLE outbox (
    event_id UUID PRIMARY KEY,
    topic TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
    occurred_at TIMESTAMPTZ NOT NULL,
    producer TEXT NOT NULL DEFAULT 'orders-service',
    correlation_id UUID NOT NULL,
    aggregate_version INTEGER CHECK (aggregate_version IS NULL OR aggregate_version >= 1),
    payload JSONB NOT NULL,
    headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT
);

CREATE INDEX outbox_pending_idx
    ON outbox (available_at, created_at)
    WHERE published_at IS NULL;

COMMIT;
