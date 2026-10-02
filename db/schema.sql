-- Endpoints: where we deliver webhooks.
CREATE TABLE endpoints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url          TEXT NOT NULL,
  event_types  TEXT[] NOT NULL DEFAULT '{}',   -- empty = subscribe to all
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signing secrets live in their own table so an endpoint can have more than
-- one at a time. During rotation the old secret stays valid until expires_at,
-- and deliveries are signed with every active secret, so receivers can switch
-- over without dropping a single webhook.
CREATE TABLE endpoint_secrets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id  UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  secret       TEXT NOT NULL,                 -- whsec_<base64>, Standard Webhooks format
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ                    -- NULL = no expiry (current secret)
);

CREATE INDEX endpoint_secrets_endpoint_idx ON endpoint_secrets (endpoint_id);

-- Events: what clients send us. idempotency_key makes retries from clients safe.
CREATE TABLE events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliveries: one row per (event, endpoint). This table IS the queue.
CREATE TABLE deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id       UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code  INT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);

-- Workers poll "pending rows that are due". Partial index keeps this fast
-- even when millions of delivered rows pile up.
CREATE INDEX deliveries_due_idx
  ON deliveries (next_attempt_at)
  WHERE status = 'pending';
