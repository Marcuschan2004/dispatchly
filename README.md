# Dispatchly

Webhook infrastructure with proven delivery guarantees and a real threat model.

Register endpoints, send events, and Dispatchly delivers them: signed per the
[Standard Webhooks](https://www.standardwebhooks.com/) spec, retried with
exponential backoff, and never silently dropped. Postgres is the only
dependency. The deliveries table is the queue.

## Run locally

    nvm use                     # Node 22
    cp .env.example .env
    docker compose up -d        # Postgres 16, schema auto-loaded
    npm install
    npm run dev                 # API on :3000 (add RUN_WORKER=true to .env to deliver too)
    npm test                    # needs Postgres; uses a separate <db>_test database

> db/schema.sql only runs on a fresh volume. After editing it:
> `docker compose down -v && docker compose up -d`

## API (so far)

    GET  /health
    POST /endpoints   {"url": "...", "event_types": ["order.paid"]}  -> returns secret once
    GET  /endpoints

## How delivery works

The worker (in the API process with `RUN_WORKER=true`, or standalone with
`npm run dev:worker`) loops over three steps:

1. **Claim** up to N due rows in one statement: `SELECT ... FOR UPDATE SKIP
   LOCKED`, then push `next_attempt_at` forward by the lease (60 s), bump
   `attempts`, and write a fresh `claim_token`. The row lock lasts only for
   that statement. While the lease runs the row is not due, so no other worker
   takes it, and no transaction is open during the HTTP call.
2. **Send** with a 10 s timeout, signed per attempt, redirects never followed.
3. **Record** the result in `delivery_attempts` and on the delivery, fenced on
   `claim_token`. 2xx is delivered; anything else retries with capped
   exponential backoff and full jitter (base 30 s, cap 1 h, honoring
   `Retry-After`); the 15th failure sets `status = 'dead'`.

If a worker dies mid-request, its lease runs out and another worker reclaims
the row. The crash costs an attempt, so a payload that kills workers still ends
up dead. If a worker stalls past its lease and wakes up, the token no longer
matches and its write is dropped. Delivery is at-least-once: every attempt
carries the same `webhook-id` (the event id) for receivers to dedupe on.

When nothing is due the worker sleeps until the next retry or lease expiry
instead of polling, so a scale-to-zero database can sleep. Ingest wakes it.

Tunables (env): `WORKER_CONCURRENCY`, `WORKER_LEASE_MS`,
`WORKER_REQUEST_TIMEOUT_MS`, `WORKER_MAX_ATTEMPTS`, `WORKER_BACKOFF_BASE_MS`,
`WORKER_BACKOFF_CAP_MS`, `WORKER_MAX_IDLE_MS`.

## Roadmap

- [x] Endpoint registration, Standard Webhooks secrets, rotation-ready schema
- [ ] Idempotent event ingestion with fan-out to subscribed endpoints
- [x] Worker: SKIP LOCKED claiming with leases, fencing, signing, backoff + jitter, dead-letter
- [ ] Replay API for dead deliveries
- [ ] Reliability proof: chaos harness (worker kills, DB drops, flaky receiver) + delivery verifier
- [ ] Security: SSRF guard incl. DNS rebinding, secret rotation, replay protection, receiver SDK, THREAT_MODEL.md
- [ ] Load test (k6), metrics, AWS deploy, CI
