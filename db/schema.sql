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

-- Exactly one current (never-expiring) secret per endpoint. The rotate route
-- already serializes on a row lock; this makes the database refuse a second
-- current secret even if that code has a bug.
CREATE UNIQUE INDEX endpoint_secrets_one_current_idx
  ON endpoint_secrets (endpoint_id) WHERE expires_at IS NULL;

-- Events: what clients send us. idempotency_key makes retries from clients safe.
CREATE TABLE events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliveries: one row per (event, endpoint). This table IS the queue, and
-- status = 'dead' is the dead-letter queue: same row, so replay is one UPDATE.
--
-- Leases: a worker claims a row by pushing next_attempt_at forward by the
-- lease length and writing a fresh claim_token. While the lease runs the row
-- is simply not due, so no other worker takes it. If the worker crashes, the
-- lease runs out and the row is due again. No transaction stays open while
-- the HTTP request is in flight.
CREATE TABLE deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting an endpoint must not erase its delivery
  -- history. Endpoints are soft-deleted with active = false.
  endpoint_id       UUID NOT NULL REFERENCES endpoints(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts          INT NOT NULL DEFAULT 0,      -- counts claims, so a crash costs an attempt
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- also the lease expiry while claimed
  claim_token       UUID,                        -- fencing token; non-NULL = in flight
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

-- The dead-letter queue, per endpoint: what GET /deliveries?status=dead and
-- bulk replay read. Partial, so it only holds the (few) dead rows.
CREATE INDEX deliveries_dead_idx
  ON deliveries (endpoint_id, created_at)
  WHERE status = 'dead';

-- Audit trail: one row per claim, inserted when the attempt starts and filled
-- in when it finishes. Keyed by claim_token rather than attempt number,
-- because replay resets deliveries.attempts and numbers can repeat. An attempt
-- whose worker died is marked 'lease_expired' when the row is reclaimed.
CREATE TABLE delivery_attempts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id       UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  claim_token       UUID NOT NULL UNIQUE,
  attempt           INT NOT NULL,
  worker_id         TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  duration_ms       INT,
  status_code       INT,
  error             TEXT,
  response_snippet  TEXT,                        -- first 1 KB of the response body
  outcome           TEXT CHECK (outcome IN ('delivered', 'retry', 'dead', 'lease_expired'))
);

CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id);

-- API keys for the management API. Only a SHA-256 hash is stored: the full
-- key is shown once at creation. Keys are 32 random bytes, so a fast hash is
-- enough; slow hashes like bcrypt exist to protect low-entropy passwords.
-- prefix is the first characters of the key, kept so a human can tell keys
-- apart in listings and logs without ever seeing a usable key.
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      BYTEA NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ                   -- NULL = active
);
