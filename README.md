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
    npm run dev                 # API on :3000

> db/schema.sql only runs on a fresh volume. After editing it:
> `docker compose down -v && docker compose up -d`

## API (so far)

    GET  /health
    POST /endpoints   {"url": "...", "event_types": ["order.paid"]}  -> returns secret once
    GET  /endpoints

## Roadmap

- [x] Endpoint registration, Standard Webhooks secrets, rotation-ready schema
- [ ] Idempotent event ingestion with fan-out to subscribed endpoints
- [ ] Worker: SKIP LOCKED claiming with leases, signing, backoff + jitter, dead-letter, replay
- [ ] Reliability proof: chaos harness (worker kills, DB drops, flaky receiver) + delivery verifier
- [ ] Security: SSRF guard incl. DNS rebinding, secret rotation, replay protection, receiver SDK, THREAT_MODEL.md
- [ ] Load test (k6), metrics, Render + Neon deploy ([decision](docs/deploy-stack.md)), CI
