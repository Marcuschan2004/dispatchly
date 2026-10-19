# Dispatchly

[![CI](https://github.com/Marcuschan2004/dispatchly/actions/workflows/ci.yml/badge.svg)](https://github.com/Marcuschan2004/dispatchly/actions/workflows/ci.yml)

A webhook delivery service that tests its reliability claim under real crashes
and treats every outbound request as an attack surface.

Your app sends Dispatchly an event; Dispatchly signs it and delivers it to
every subscribed endpoint, retrying until it succeeds or lands in a
dead-letter queue you can replay. TypeScript, Fastify and Postgres 16.
Postgres is the only dependency: the `deliveries` table is the queue.

## What makes it different

**Reliability you can check.** Once `POST /events` returns 2xx, every delivery
of that event ends `delivered` or `dead`, never missing. A chaos harness
`kill -9`s workers, the API and Postgres while a receiver fails most requests,
then a verifier checks every single delivery against the database and the
receiver's own log. It exits 1 if one is lost.

**Security on both sides of the wire.** API keys stored as hashes, an SSRF
guard that also catches DNS rebinding, [Standard Webhooks](https://www.standardwebhooks.com/)
HMAC signatures, replay protection on the receiver, secret rotation with
zero failed deliveries during the switch, and signing secrets encrypted at
rest.

## Chaos results

Output of `npm run chaos` on a MacBook Pro (Apple silicon), run
2026-10-19T22-28-38-110Z:

**PASS**: 0 of 3,000 deliveries missing (1,000 accepted events x 3 endpoints).

| Check | Result |
| --- | --- |
| Events accepted (POST /events answered 2xx) | 1,000 |
| Deliveries expected | 3,000 |
| Delivered, confirmed in the receiver's log | 1,991 |
| Dead-lettered after 6 attempts | 1,009 (1,000 to the always-500 endpoint) |
| Missing (lost, stuck, or "delivered" but never received) | 0 |
| Dead-lettered, though the receiver had processed it | 7 |
| Duplicate deliveries (receiver processed the same webhook-id again) | 249 (12.46% of 1,998 received) |
| ...after a lost 200 (the receiver's fault, injected) | 230 |
| ...after a worker crash, pause or failed result write | 19 |
| Most copies of one delivery | 4 |
| Bad signatures seen by the receiver | 0 |
| Workers that exited without being killed | 0 |
| Idempotency-Key spot checks (same key, same event) | 51/51 |

Faults injected:

- 35 worker SIGKILLs (5 of them whole-fleet), 4 SIGSTOP pauses past the 5 s lease
- 3 API SIGKILLs, 2 Postgres crash-restarts
- 6,971 receiver faults (500s, hangs, dropped connections, lost 200s) out of 8,983 requests
- 164 attempts abandoned mid-flight by a crash, 6 stale results dropped by the claim_token fence

9,088 delivery attempts in 56 s; 4 workers; seed 900524755; darwin arm64, 8 CPUs, Node 22.23.3.

Duplicates are expected and counted, not hidden: delivery is at-least-once,
and every copy carries the same `webhook-id` for the receiver to drop. The
harness uses short demo timings (6 attempts, 1 s to 10 s backoff) so a full
retry-to-dead cycle fits in a minute. How it works and what it can't catch:
[docs/chaos-harness.md](docs/chaos-harness.md).

## Architecture

```mermaid
flowchart LR
    C[Your app] -- "POST /events<br/>Idempotency-Key" --> A[API<br/>Fastify]
    A -- "one transaction:<br/>event + one delivery per endpoint" --> P[(Postgres<br/>deliveries = queue)]
    A -. wake .-> W
    W[Workers] -- "claim with SKIP LOCKED,<br/>lease + claim_token" --> P
    W -- "signed POST,<br/>SSRF-checked connection" --> R[Receiver]
    R -- "verify HMAC + timestamp,<br/>dedupe on webhook-id" --> R
```

1. **Ingest.** `POST /events` writes the event and one `deliveries` row per
   subscribed endpoint in a single transaction, so an accepted event always
   has its deliveries. There is no second system to dual-write to.
2. **Claim.** A worker claims due rows with `FOR UPDATE SKIP LOCKED`, pushes
   `next_attempt_at` forward as a lease and writes a fresh `claim_token`. No
   transaction stays open during the HTTP call.
3. **Send and record.** The result is written only if the `claim_token` still
   matches. A crashed worker's lease expires and another worker retries the
   row; a worker that stalled past its lease has its late write dropped.

Workers run inside the API process (`RUN_WORKER=true`, one free-tier service)
or as separate processes (`npm run dev:worker`, or `npm run worker` after a build). When nothing is due, a worker
sleeps until the next retry instead of polling, so a scale-to-zero database
can sleep too.

## Delivery guarantees

- **At-least-once, never exactly-once.** If a receiver processes a webhook and
  its 200 is lost, Dispatchly can't tell that from a failure and must resend.
  Every attempt and replay of an event carries the same `webhook-id` (the
  event id), so receivers dedupe on it. `examples/receiver.ts` shows how.
- **Idempotent ingest.** Retrying `POST /events` with the same
  `Idempotency-Key` returns the original event (200). The same key with a
  different body is refused (422) instead of silently dropping the new event.
- **Retries.** Any non-2xx, timeout or connection error is retried with capped
  exponential backoff and full jitter (base 30 s, cap 1 h, 10 s request
  timeout), honoring `Retry-After`. Redirects are failures, never followed.
- **Dead-letter queue and replay.** After 15 failed attempts (about 8 hours at
  most, 4 on average) a delivery becomes `dead`. Replay one, or every dead
  delivery of an endpoint, and it goes back in the queue with a fresh retry
  budget, the same `webhook-id`, and signatures from the current secrets.

Design and tradeoffs: [docs/reliability-design.md](docs/reliability-design.md).

## Security

- **API keys.** Every route except `/health` needs `Authorization: Bearer
  <key>`. Keys are created from the CLI, and only a SHA-256 hash is stored.
  `AUTH_DISABLED=true` (local scripts only) is refused unless `HOST` is a
  loopback address.
- **SSRF guard.** Endpoint URLs come from callers, so Dispatchly must not
  become a way into its own network. The URL is checked at registration and
  before every attempt: https only, ports 443 and 80, no credentials in the
  URL, and no private, loopback, link-local (cloud metadata), CGNAT,
  multicast or reserved address, including disguised forms like
  `http://2130706433`. The connection itself goes through a DNS lookup hook
  that refuses blocked addresses and connects to the address it checked, so
  DNS rebinding fails too.
- **HMAC signing.** Standard Webhooks v1: base64 HMAC-SHA256 over
  `webhook-id.webhook-timestamp.body`, signed fresh on every attempt. Tests
  check it against the official `standardwebhooks` library in both
  directions.
- **Replay protection.** `verifyWebhook()` in `src/security/signing.ts`
  compares signatures in constant time and rejects timestamps more than 300 s
  off. The example receiver records each `webhook-id` in the same transaction
  as its own work, so a replay inside the window is answered 200 and skipped.
- **Secret rotation.** Rotating gives older secrets an expiry 0 to 72 hours
  out (default 24). Until then each delivery carries one signature per live
  secret, so a receiver can switch whenever it likes. `overlap_hours: 0`
  revokes the old secrets at once, for a leak. At most 3 live secrets per
  endpoint.

- **Secrets encrypted at rest.** Signing secrets are stored AES-256-GCM
  encrypted under `SECRETS_ENCRYPTION_KEY` (base64 of 32 bytes), with a
  fresh random nonce per secret and the endpoint id as authenticated data,
  so a copied ciphertext won't decrypt on another endpoint. Each row records
  its key version. The API and worker refuse to start without a valid key
  unless `HOST` is loopback, where they fall back to a public dev key, and
  refuse a key that can't decrypt the stored secrets. A test reads the
  table's data file on disk and finds no secret in any form.

Threat model and design: [docs/security-delivery.md](docs/security-delivery.md).

## Quickstart (macOS)

Needs Node 22.9 or newer (`nvm use` picks it up from `.nvmrc`) and Docker
Desktop, opened before you start.

```sh
git clone https://github.com/Marcuschan2004/dispatchly.git
cd dispatchly
cp .env.example .env
docker compose up -d
npm install
npm test
```

`docker compose up -d` starts Postgres 16 on port 5433 and loads
`db/schema.sql` on first start. Tests run against a separate
`dispatchly_test` database. After changing the schema, reset the volume with
`docker compose down -v && docker compose up -d`.

A database created before secrets were encrypted needs `npm run
encrypt-secrets` once (stop the API and workers first). It encrypts every
secret in one transaction, drops the plaintext column, rewrites the table so
no old copy stays in its data file, and does nothing if run again.

### Watch a webhook arrive

Use three terminals. The extra variables let the SSRF guard deliver to a
receiver on your own machine, which production refuses.

Terminal 1, the API with a worker:

```sh
RUN_WORKER=true ENDPOINT_ALLOW_HTTP=true ENDPOINT_ALLOW_PORTS=4000 ENDPOINT_ALLOW_IPS=127.0.0.1 npm run dev
```

Terminal 2, register an endpoint and copy the `secret` from the response
(it is shown only once), then start the example receiver with it:

```sh
curl -s -X POST localhost:3000/endpoints -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4000/hook"}'
WEBHOOK_SECRET=whsec_paste_your_secret_here npm run receiver
```

Terminal 3, send an event:

```sh
curl -s -X POST localhost:3000/events -H 'content-type: application/json' -H 'idempotency-key: order-7' -d '{"type":"order.paid","payload":{"order_id":7}}'
```

The receiver logs `processed`, then a `replay_with` curl command holding the
exact request it received. Run that command right away and the receiver
answers `duplicate`; run it after 5 minutes and it answers 401
(`timestamp_out_of_window`).

### Run the chaos harness

```sh
npm run chaos
```

It uses its own `dispatchly_chaos` database, takes about a minute, and
crash-restarts the Docker Postgres container while it runs.

## API

The local `.env` sets `AUTH_DISABLED=true`, which is why the examples above
send no key. To try auth, delete that line, restart, and create a key:

```sh
npm run api-key -- create my-app
curl -s localhost:3000/endpoints -H 'authorization: Bearer dk_paste_your_key_here'
```

`npm run api-key -- list` and `npm run api-key -- revoke <id or prefix>`
manage keys.

| Method and path | Body or query | Returns |
| --- | --- | --- |
| `GET /health` | | 200, no key needed |
| `POST /endpoints` | `{"url", "event_types": []}` (empty means all types) | 201 with the signing secret, shown once; 400 if the SSRF guard blocks the URL |
| `GET /endpoints` | | Endpoints, never secrets |
| `POST /events` | `{"type", "payload": {}}`, optional `Idempotency-Key` header | 201 new, 200 same key and body, 422 same key with another body |
| `GET /deliveries` | `?status=pending\|delivered\|dead&endpoint_id=&limit=50&cursor=` | Newest first, keyset-paginated; `status=dead` is the dead-letter queue |
| `POST /deliveries/:id/replay` | | 202; 409 unless the delivery is dead and its endpoint active |
| `POST /endpoints/:id/replay` | `{"since": "2026-10-17T00:00:00Z"}` (optional) | 202 with the number of dead deliveries requeued |
| `POST /endpoints/:id/secrets/rotate` | `{"overlap_hours": 24}` (0 to 72) | 201 with the new secret, shown once; 409 at 3 live secrets |
| `GET /endpoints/:id/secrets` | | Live secrets' ids and expiry times, never the secrets |

Each webhook is a POST with a JSON body `{"type", "timestamp", "data"}` and
the headers `webhook-id`, `webhook-timestamp` and `webhook-signature`.

## Limits

Honest about what it doesn't do yet:

- **At-least-once only.** Receivers must dedupe on `webhook-id`. In the run
  above, Dispatchly's own crashes caused 19 extra copies, and 7 deliveries
  were dead-lettered even though the receiver had processed them, because its
  answers never got back to Dispatchly.
- **No per-endpoint fairness.** One slow endpoint can hold every worker slot
  for up to the 10 s timeout per request, delaying everyone else's webhooks.
- **Not deployed.** It runs locally and in CI. The planned free-tier stack is
  Render and Neon ([docs/deploy-stack.md](docs/deploy-stack.md)).
- **Encryption at rest stops a leaked dump, not a compromised server.** The
  key sits in the environment next to `DATABASE_URL`, so anyone who can read
  the server's environment can decrypt. A KMS would fix that and is out of
  scope on free tiers. Rotating the key itself needs a re-encrypt command
  that isn't built yet; the key version column is there for it.
- **API keys are single-tenant** and there is no rate limiting.
- **Chaos testing is statistical.** One machine, loopback network, random
  faults. It finds common races, not one-in-a-million interleavings; those
  have targeted tests, like the SIGSTOP fencing test in `test/worker.test.ts`.

## Design docs

- [Reliability design](docs/reliability-design.md): queue, leases, fencing, retries, dead-letter queue
- [Security delivery layer](docs/security-delivery.md): signing, replay protection, SSRF, rotation
- [Chaos harness](docs/chaos-harness.md): fault injection, the verifier, all results
- [Deploy stack](docs/deploy-stack.md): why Render and Neon, and why Postgres is the queue
- [Deploy guide](docs/deploy.md): the steps to put it on Render and Neon

CI runs typecheck, build, the test suite and `scripts/check-events.sh` against
Postgres 16 on every push to main and every pull request.
