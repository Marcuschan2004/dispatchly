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

    GET  /health                                                     (no key needed)
    POST /endpoints   {"url": "...", "event_types": ["order.paid"]}  -> returns secret once
    GET  /endpoints
    POST /events      {"type": "order.paid", "payload": {...}}       Idempotency-Key header optional
    POST /endpoints/:id/secrets/rotate  {"overlap_hours": 24}        -> returns new secret once
    GET  /endpoints/:id/secrets                                      live secrets, metadata only

Every route except `/health` needs `Authorization: Bearer <api key>`. Keys are
created from the command line, because the first key can't come from an API
that needs a key:

    npm run api-key -- create my-app      # prints the key once
    npm run api-key -- list
    npm run api-key -- revoke dk_AbCdEfGh  # by id or by the prefix shown in list

(In production, after `npm run build`: `node dist/cli/api-keys.js create my-app`.)

Only a SHA-256 hash of each key is stored. `.env.example` sets
`AUTH_DISABLED=true` so local scripts like `scripts/check-events.sh` work
without a key; the server refuses to start with it unless `HOST` is a loopback
address.

## SSRF guard

Endpoint URLs come from API callers, so Dispatchly must not become a way to
reach its own network. `src/security/ssrf.ts` checks in two places:

- **The URL, at registration and before every attempt:** https only, ports 443
  and 80, no `user:pass@`, and no IP-literal host in a private, loopback,
  link-local (cloud metadata), CGNAT, multicast or reserved range. Checks run
  on the parsed URL, so `http://2130706433` and `http://0x7f.1` are caught as
  `127.0.0.1`. Registration also resolves the name once for fast feedback.
- **The connection, on every attempt:** deliveries go through an undici
  `Agent` whose `connect.lookup` resolves the name and refuses if any address
  is blocked. The socket connects to the address that was checked, so DNS
  rebinding (public at registration, `127.0.0.1` at delivery) fails. Node skips
  `lookup` for IP literals, which is why the URL check runs every attempt too.

Redirects are never followed; a 3xx is a failed attempt. For local demos,
`ENDPOINT_ALLOW_HTTP`, `ENDPOINT_ALLOW_PORTS` and `ENDPOINT_ALLOW_IPS` open
exceptions (see `.env.example`).

## Secret rotation

`POST /endpoints/:id/secrets/rotate` creates a new current secret and gives
every older one an expiry `overlap_hours` from now (0 to 72, default 24).
Until then each delivery carries one `v1,` signature per live secret, newest
first, so a receiver can switch to the new secret whenever it likes without a
single delivery failing. `overlap_hours: 0` is for a leaked secret: all older
secrets stop working on the next delivery.

Rotations of one endpoint run one at a time (`SELECT ... FOR UPDATE` on the
endpoint row), and a partial unique index guarantees one current secret even
if that logic breaks. An endpoint can have at most 3 live secrets, which keeps
the signature header small.

## Replay protection

A signed request stays valid forever unless the receiver bounds it, so
replay protection takes a timestamp window and a seen-id store together.

- **Sender:** every attempt carries a fresh `webhook-timestamp` inside the
  signed content and the same `webhook-id` (the event id).
- **Receiver:** `verifyWebhook(headers, rawBody, secrets)` in
  `src/security/signing.ts` checks the HMAC (constant-time compare), then
  rejects timestamps more than 300 s off in either direction. It agrees with
  the official `standardwebhooks` library in both directions (tests).
- **Dedupe:** `examples/receiver.ts` records each `webhook-id` in a
  `processed_webhooks` table in the same transaction as its own work, so a
  copy replayed inside the window, or a retry, is answered 200 and skipped.

Try it (two terminals, Dispatchly on :3000 with `RUN_WORKER=true` and the
three `ENDPOINT_ALLOW_*` lines from `.env.example` uncommented, with
`ENDPOINT_ALLOW_PORTS=4000`):

    curl -s -X POST localhost:3000/endpoints -H 'content-type: application/json' \
      -d '{"url":"http://127.0.0.1:4000/hook"}'          # note the secret
    WEBHOOK_SECRET=whsec_... npm run receiver
    curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
      -d '{"type":"order.paid","payload":{"order_id":7}}'

The receiver logs `processed` and a `replay_with` curl command holding the
exact captured request. Run it right away: `duplicate`. Run it after 5
minutes: `401`, `timestamp_out_of_window`.

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
- [x] Security: API keys, SSRF guard incl. DNS rebinding, secret rotation, replay protection + receiver example
- [ ] Secrets encrypted at rest, THREAT_MODEL.md
- [ ] Load test (k6), metrics, Render + Neon deploy ([decision](docs/deploy-stack.md)), CI
