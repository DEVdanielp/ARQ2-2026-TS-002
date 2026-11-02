BEGIN;

ALTER TABLE outbox
    ADD COLUMN lease_owner UUID,
    ADD COLUMN lease_expires_at TIMESTAMPTZ;

CREATE INDEX outbox_pending_lease_idx
    ON outbox (available_at, lease_expires_at, created_at)
    WHERE published_at IS NULL;

COMMIT;
