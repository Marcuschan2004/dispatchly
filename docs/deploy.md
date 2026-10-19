# Deploying to Render and Neon

How to put Dispatchly online on free tiers. [deploy-stack.md](deploy-stack.md)
explains why this stack; this page is the checklist. Everything below is
done by hand in the Neon and Render dashboards. Never paste the connection
string or keys anywhere except the dashboards and your own terminal.

## What the repo already does

- `render.yaml` describes one free Render web service running the API and the
  delivery worker in one process (`RUN_WORKER=true`), in Oregon, deploying
  from `main` on every push.
- Every start runs `npm run migrate` first. It applies `db/schema.sql` to an
  empty database, then any new files in `db/migrations/`, and does nothing
  when the schema is current. Free instances can't run a pre-deploy command,
  which is why it runs at start; a cold start costs one extra query.
- `GET /livez` answers without touching Postgres, so Render's health checks
  and the keep-warm pinger don't stop Neon from scaling to zero.
  `GET /health` still runs `SELECT 1`.
- A retention job deletes events older than `RETENTION_DAYS` (7) once all of
  their deliveries have succeeded, along with those deliveries and their
  attempt log. It runs at start and every 6 hours.

## 1. Create the Neon database

1. In the Neon console, create a project. Pick **Postgres 16** (it matches
   CI and docker compose) and the region **AWS US West 2 (Oregon)**.
2. On the project dashboard, click **Connect**. Turn **Connection pooling
   off**: the migration runner holds an advisory lock for the whole session,
   which a pooled (`-pooler`) connection can't keep.
3. Copy the connection string. It ends in
   `?sslmode=require&channel_binding=require`. Replace that ending with
   `?sslmode=verify-full`. node-postgres ignores `channel_binding`, and it
   already treats `require` as `verify-full` but logs a warning on every
   start. Keep the result somewhere private; you'll paste it into Render.

You don't need to load the schema yourself. The first deploy does it.

## 2. Generate the encryption key

Endpoint signing secrets are encrypted at rest with `SECRETS_ENCRYPTION_KEY`,
the base64 of 32 random bytes. On your Mac:

```sh
openssl rand -base64 32
```

Store the output in your password manager too. If it is lost, every endpoint
secret has to be rotated.

Deploy only once the encryption at rest change is merged into `main`. It
changes how `db/schema.sql` stores secrets, and the first deploy freezes
that file as the baseline: a database created before the change would need
the separate `npm run encrypt-secrets` step run against Neon by hand.

## 3. Create the Render service from the Blueprint

1. In the Render dashboard, choose **New > Blueprint** and pick the
   `dispatchly` repository. Render reads `render.yaml` and shows one free web
   service named `dispatchly`.
2. It asks for the two variables marked `sync: false`:
   - `DATABASE_URL`: the Neon string from step 1.
   - `SECRETS_ENCRYPTION_KEY`: the key from step 2.
3. Click **Apply**. The first build takes a few minutes. In the deploy logs,
   look for `migrate: 0000_schema.sql: applied`, then `Server listening`.

`HOST`, `RUN_WORKER`, `RETENTION_DAYS` and `SECRETS_ENCRYPTION_KEY_VERSION`
come from `render.yaml`. To change
one, edit the file and push, so the repo stays the record. Don't set
`AUTH_DISABLED`: the server refuses to start with it on a public `HOST`.

## 4. Check it

Your service URL is on the service page, like
`https://dispatchly-xxxx.onrender.com`.

```sh
curl https://dispatchly-xxxx.onrender.com/livez
curl https://dispatchly-xxxx.onrender.com/health
```

Both should return `{"ok":true}`. The first request after the service has
been asleep takes about a minute.

## 5. Create an API key

There's no shell on a free Render instance, so create the first key from
your Mac, pointed at Neon. `read -rs` keeps the connection string out of
your shell history:

```sh
cd ~/Dispatchly
read -rs "NEON_URL?Neon connection string: "
DATABASE_URL="$NEON_URL" npm run api-key -- create demo
unset NEON_URL
```

A variable set in the shell wins over `.env`, so this writes to Neon, not to
your local database. The key is printed once; store it.

## 6. Keep it awake

Render stops a free service after 15 minutes with no requests. On
cron-job.org (free), create a job that sends `GET` to
`https://dispatchly-xxxx.onrender.com/livez` every 10 minutes. While it is
asleep, retries that come due wait until the next request wakes it; nothing
is lost.

## 7. Send a real webhook

Get a receiving URL from webhook.site, then:

```sh
read -rs "DK?API key: "
curl -s https://dispatchly-xxxx.onrender.com/endpoints -H "Authorization: Bearer $DK" -H "content-type: application/json" -d '{"url":"https://webhook.site/your-id"}'
curl -s https://dispatchly-xxxx.onrender.com/events -H "Authorization: Bearer $DK" -H "content-type: application/json" -H "Idempotency-Key: demo-1" -d '{"type":"order.paid","payload":{"id":1}}'
```

The webhook should show up on webhook.site within a second or two, with
`webhook-id`, `webhook-timestamp` and `webhook-signature` headers.

## Running costs to watch

- **Neon storage (0.5 GB).** Retention keeps delivered history to 7 days.
  Dead letters are never pruned, so an endpoint that fails for weeks keeps
  growing the table until you replay or delete its deliveries. Neon's
  dashboard shows storage use.
- **Neon compute (100 CU-hours a month).** With no traffic the worker queries
  once every 10 minutes, so Neon sleeps about half the time. Busy demo days
  cost more.
- **Render hours (750 a month).** Enough for one service running all month.
  Don't add a second free service.

## Changing the schema later

Don't edit `db/schema.sql` once this is deployed. Add a numbered file to
`db/migrations/` instead; see the README there. It is applied on the next
deploy, and locally with `npm run build && npm run migrate`.
