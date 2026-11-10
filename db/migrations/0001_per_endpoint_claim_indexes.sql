-- Indexes for the per-endpoint in-flight cap in the worker's claim query.

-- An endpoint's due rows, oldest first: claim() takes at most a few from the
-- front for each endpoint, so a backlog of thousands costs one short index
-- range, not a scan. id breaks ties so concurrent workers rank rows the same
-- way (bulk ingest gives many rows the same next_attempt_at).
CREATE INDEX deliveries_endpoint_due_idx
  ON deliveries (endpoint_id, next_attempt_at, id)
  WHERE status = 'pending';

-- Claimed rows whose result isn't written yet: the in-flight count per
-- endpoint. Small, because a row leaves it as soon as its attempt finishes.
CREATE INDEX deliveries_in_flight_idx
  ON deliveries (endpoint_id)
  WHERE status = 'pending' AND claim_token IS NOT NULL;
