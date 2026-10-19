# Security delivery layer

Design for signing, replay protection, SSRF defense and secret rotation.
Last updated 2026-10-19.

## Summary

Dispatchly implements the [Standard Webhooks](https://www.standardwebhooks.com/)
v1 spec exactly, then adds what the spec leaves to the sender: connect-time
SSRF checks, signing with every active secret during rotation, and encrypted
secrets at rest. Matching the spec byte for byte means receivers can verify
with the official `standardwebhooks` npm library, so the signing code is
checked by an independent implementation.

The threat model has two attackers:

- A **network attacker** can see, capture, replay or modify webhook requests
  between Dispatchly and a receiver.
- A **malicious tenant** can register any URL as an endpoint and wants
  Dispatchly to make requests into its own network (database, cloud metadata,
  admin panels).

| Mechanism | Threat it stops | How it is proven |
| --- | --- | --- |
| HMAC-SHA256 signing | Forged or modified webhooks | Official library verifies Dispatchly's signatures; one flipped body byte fails |
| Timestamp window + webhook-id dedupe | Replay of a captured request | Fake clock: same request at +6 min fails; twice inside the window is processed once |
| SSRF guard at connect time | Tenant uses Dispatchly to reach internal hosts | Private IPs, DNS rebinding and redirects to 169.254.169.254 never receive a request |
| Overlapping secret rotation | Leaked secret stays valid forever; rotation drops events | During overlap both old and new verifiers accept; after expiry only the new one does |

Known gap outside this design: the API has no authentication yet, so anyone
who can reach it can register endpoints and send events. A static API key per
tenant should land before the security layer.

## 1. HMAC-SHA256 signing

Every delivery attempt carries three headers, and the signature covers the
id, the timestamp and the exact body bytes.

```
webhook-id: msg_<event uuid>
webhook-timestamp: 1792440000
webhook-signature: v1,<base64 sig A> v1,<base64 sig B>
```

**How it works**

1. Key = base64-decode the secret after stripping `whsec_`. `newSecret()`
   generates 32 random bytes, inside the spec's 24 to 64 byte range.
2. Signed content = `${webhookId}.${timestamp}.${body}`.
   Signature = base64(HMAC-SHA256(key, content)).
3. Serialize the payload to a string once per attempt, sign that string, and
   send that same string. Postgres JSONB reorders keys, so re-serializing
   between signing and sending breaks verification.
4. `webhook-id` is the event id and stays the same on every retry and for
   every endpoint. `webhook-timestamp` is the time of this attempt, so a retry
   hours later is re-signed and still passes the receiver's window.
5. One `v1,` entry per active secret, space separated (section 4).
6. The receiver recomputes the HMAC and compares with
   `crypto.timingSafeEqual`, never `===`. A normal string compare exits at the
   first wrong byte, so response timing leaks how much of a guess was right.

**Threat.** A network attacker forges an event (`order.paid` for an order
never paid) or edits a real body. Without the key they cannot produce a
matching HMAC. Putting the id and timestamp inside the signed content stops
them from moving either header onto an old body.

**Not covered.** Replay of a valid request (section 2), and anyone who has
stolen the secret (section 4 and encryption at rest).

**How to test**

- Cross-check: sign with `src/security/signing.ts`, verify with the official
  `standardwebhooks` library. Then the reverse: the library signs with a fixed
  id, timestamp and secret, and Dispatchly's verifier accepts it.
- Tamper tests, each must fail: one changed body byte, a changed
  `webhook-id`, a changed timestamp, a signature from a different secret, a
  header containing only a `v2,` entry.
- A header with one valid and one garbage signature must pass, since rotation
  depends on it.
- Node's built-in `node:test` runner is enough; no new test dependency.

## 2. Replay protection

A signed request is valid forever unless the receiver bounds it, so replay
protection is two checks that only work together: a timestamp window and a
seen-id store.

**How it works (receiver side, in the verify helper)**

1. Verify the signature first. Until the HMAC checks out, the timestamp is
   just text the attacker chose.
2. Reject if `|now - webhook-timestamp| > 300` seconds. Check both
   directions; a far-future timestamp would otherwise stay valid as long as
   the attacker likes.
3. Record `webhook-id` and skip processing if already seen. For replay alone
   the store only needs to cover the 5-minute window, because anything older
   already fails step 2.
4. Keep ids longer (7 days, matching the retry schedule) when the receiver
   also wants idempotency. A legitimate retry has a fresh timestamp and the
   same id, so the id store turns "delivered twice" into "processed once". A
   unique index on a `processed_webhooks(id)` table does this in Postgres;
   Redis is not needed.

**Sender side.** Dispatchly sends a fresh timestamp per attempt and a stable
id. That is why retries never trip the window.

**Threat.** A network attacker captures a valid `order.paid` request and sends
it again an hour later, or 50 times within a second. Signing alone accepts
every copy.

**Not covered.** A replay inside the 5-minute window to a receiver that skips
the id check. The window is a bound, not a guarantee; the dedupe closes it.

**How to test**

- Inject the clock (`verify(headers, body, secrets, { now })`); no real
  waiting.
- Same request at +299 s passes, at +301 s fails, at -301 s fails.
- Same request twice at +10 s: the first is processed, the second returns 200
  and is skipped.
- End-to-end demo: capture a delivered request at the test receiver and
  resend it with curl after the window; the receiver logs a rejection.

## 3. SSRF defenses

The check that matters runs at connect time, on the exact IP the socket is
about to use. Checking the URL only at registration is not enough, because
DNS can change after the check.

**Current gap.** `z.string().url()` in `src/routes/endpoints.ts` accepts
`file:///etc/passwd`, `gopher://127.0.0.1:6379/_x` and
`http://169.254.169.254/latest/meta-data/` (verified against zod 3.25).

**How it works**

1. **At registration (fast feedback):** parse with `new URL()`, require
   `https:` (allow `http:` only behind a dev flag), allow ports 443 and 80
   only, reject userinfo (`user:pass@`), and reject hostnames that are IP
   literals in a blocked range. Resolve the name once and reject if any
   address is blocked.
2. **At every delivery attempt (the real defense):** use an undici `Agent`
   whose `connect.lookup` resolves the name with `all: true`, rejects if
   **any** returned address is blocked, and hands the validated addresses to
   the socket. Validation and connection share one DNS answer, which defeats
   DNS rebinding.
3. **IP literals skip `lookup`.** Node does not call `lookup` when the host is
   already an IP, so step 2 alone lets `http://127.0.0.1` through (verified:
   `localhost` was blocked, `127.0.0.1` reached the server). Re-check the URL
   host before every attempt.
4. **Normalize first.** `new URL()` turns `http://2130706433/`,
   `http://0x7f.1/` and `http://017700000001/` into `127.0.0.1`, so always
   check the parsed `hostname`, never the raw string. Node 22's
   `net.BlockList` matches IPv4-mapped IPv6 such as `[::ffff:7f00:1]` against
   IPv4 rules (verified).
5. **Redirects:** `redirect: "manual"` and treat every 3xx as a failed
   attempt, as Standard Webhooks recommends. Following a redirect would skip
   every check above for the new host.
6. **Limits:** connect timeout 5 s, total 15 s, read at most 64 KB of the
   response body and store it truncated, so slow or huge responses cannot tie
   up workers.

**Blocked ranges** (`net.BlockList`, no dependency)

| Range | Why |
| --- | --- |
| 127.0.0.0/8, ::1 | Loopback: services on the Dispatchly host |
| 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7 | Private networks: the database, other internal services |
| 169.254.0.0/16, fe80::/10 | Link-local, including 169.254.169.254 cloud metadata |
| 100.64.0.0/10 | Carrier-grade NAT, used inside some cloud networks |
| 0.0.0.0/8, ::/128 | "This host"; 0.0.0.0 reaches localhost on Linux and macOS |
| 224.0.0.0/4, 240.0.0.0/4, ff00::/8 | Multicast and reserved |
| 64:ff9b::/96 | NAT64: can embed a private IPv4 address |
| 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32 | Special use and documentation ranges |

**Threat.** A malicious tenant registers `http://169.254.169.254/...`, or a
domain they control that resolves to a public IP at registration and to
`127.0.0.1` at delivery. Dispatchly then reads cloud credentials or hits an
admin port, and the response body shown in delivery logs hands the result
back to the attacker.

**Alternative at scale (not built):** route all egress through a filtering
proxy such as Stripe's open source smokescreen, or run workers in a subnet
with no route to internal services. Both are what the spec recommends; on
free tiers the in-process guard is the right size.

**How to test**

- Table-driven unit tests of the IP classifier: every row above, plus public
  addresses that must pass (8.8.8.8, 2606:4700::1111).
- Registration rejects `file:`, `gopher:`, `http://127.0.0.1`,
  `http://2130706433`, `http://[::ffff:127.0.0.1]`,
  `https://user:pw@example.com`, and port 6379.
- `http://127.0.0.1.nip.io` (public DNS that answers 127.0.0.1) is blocked at
  connect time.
- DNS rebinding: inject a resolver that returns 93.184.216.34 on the first
  call and 127.0.0.1 on the second; a local server on 127.0.0.1 must log zero
  requests.
- Redirect: a test receiver returns `302 Location: http://169.254.169.254/`;
  the attempt is recorded as failed with status 302 and no second request is
  made.
- Tests deliver to a local receiver, so the guard takes a policy object;
  tests allow exactly one `127.0.0.1:<port>`, production allows none.

## 4. Secret rotation with overlapping secrets

The `endpoint_secrets` table already has the right shape. What is missing is
the rotate endpoint, one index, and the worker query that signs with every
live secret.

**How it works**

1. `POST /endpoints/:id/secrets/rotate` with optional
   `{"overlap_hours": 24}` (0 to 72; 0 revokes the old secret immediately,
   for a leak).
2. In one transaction: `SELECT ... FROM endpoints WHERE id = $1 FOR UPDATE`
   so two rotations cannot interleave, set `expires_at = now() + overlap` on
   the current secret, insert the new one with `expires_at = NULL`, and return
   it once.
3. Add
   `CREATE UNIQUE INDEX ON endpoint_secrets (endpoint_id) WHERE expires_at IS NULL`.
   The database then guarantees exactly one current secret, even if the lock
   logic has a bug.
4. The worker loads secrets `WHERE expires_at IS NULL OR expires_at > now()`
   and puts one `v1,` signature per row in the header, newest first. Cap live
   secrets at 3 so a rotate loop cannot bloat headers.
5. Receivers update their stored secret any time inside the overlap. Whichever
   secret they hold matches one signature, so no delivery fails during the
   switch.
6. Delete expired rows in the worker's housekeeping loop.

**Encryption at rest (built).** HMAC needs the raw secret, so it cannot be
hashed like an API key; storage has to be reversible. `src/security/encryption.ts`:

1. AES-256-GCM from `node:crypto`, key from `SECRETS_ENCRYPTION_KEY` (base64
   of exactly 32 bytes; the value is round-tripped so a typo is an error, not
   a silently different key).
2. A fresh 12-byte random nonce per encryption. GCM breaks badly if a nonce
   repeats under one key (it leaks the XOR of the plaintexts and allows tag
   forgery); random 96-bit nonces are safe far past this table's size.
3. Stored as one `BYTEA`, `nonce || ciphertext || tag`, plus
   `secret_key_version INT`. The version is a column so the database can
   answer "which rows still use the old key" during a key rotation.
4. The endpoint id is GCM's additional authenticated data. Someone with
   write access to the database can't copy one endpoint's ciphertext onto
   another endpoint's row; it fails to decrypt. That is why the create route
   now picks the endpoint id in the app instead of the database.
5. The worker loads ciphertexts in its claim query and decrypts in `send()`,
   so a bad row fails that one attempt with a recorded error and nothing is
   sent unsigned.
6. Startup: the API and worker refuse to start without a valid key unless
   `HOST` is loopback (the same rule as `AUTH_DISABLED`), where they use a
   public dev key with version 0. Then they decrypt one row per key version
   and refuse to start if that fails, so a wrong key is one clear error
   instead of every delivery slowly dead-lettering.
7. Migration: `npm run encrypt-secrets` adds the columns, encrypts every
   plaintext row and drops the plaintext column in one transaction, then runs
   `VACUUM FULL`. `DROP COLUMN` only hides a column and each `UPDATE` leaves
   the old row version behind, so without the rewrite the plaintext stays in
   the table's data file.

Limits: on a free host the key sits next to the database URL, so this
protects against a leaked backup, SQL dump or read-only database
credential, not a full server compromise. A KMS would move the key off the
host and is out of scope. The migration cannot reach backups or WAL written
before it ran, so secrets that were ever stored in plaintext should be
rotated. Rotating the encryption key itself is not built: it needs the old
key accepted for decryption and a command that re-encrypts rows below the
current version.

**Threat.** A secret leaks (logged by a receiver, committed to a repo, a dump
of the database). Without rotation it stays valid forever. If rotation needs
a hard cutover, teams avoid rotating because it drops webhooks, which has the
same outcome.

**How to test**

- Rotate, deliver, assert two `v1,` entries; a verifier holding only the old
  secret and one holding only the new secret both accept.
- Move the old row's `expires_at` into the past, deliver, assert one entry and
  that the old-secret verifier rejects.
- `overlap_hours: 0` makes the old secret fail on the very next delivery.
- Fire 10 concurrent rotate calls; exactly one row has `expires_at IS NULL`
  afterwards.
- `GET /endpoints` and logs never contain `whsec_` (grep the test log
  output).
- `test/encryption.test.ts`: after creating and rotating secrets, neither the
  rows nor the table's data file on disk (read with `pg_read_binary_file`
  after a `CHECKPOINT`) contains any secret as `whsec_` text, base64 or raw
  key bytes. The same probe finds the plaintext in a pre-encryption table, and
  finds nothing after the migration.
- Tampering with any byte of the nonce, ciphertext or tag, moving a
  ciphertext to another endpoint, or using the wrong key fails to decrypt.

## 5. Compared with Stripe and Standard Webhooks

Dispatchly follows Standard Webhooks on the wire and adds a both-directions
timestamp check and connect-time SSRF checks.

| | Stripe | Standard Webhooks | Dispatchly |
| --- | --- | --- | --- |
| Headers | `Stripe-Signature: t=…,v1=…` | `webhook-id`, `webhook-timestamp`, `webhook-signature` | Same as Standard Webhooks |
| Signed content | `timestamp.body` | `id.timestamp.body` | `id.timestamp.body` |
| Encoding | Hex | Base64, `v1,` prefix | Base64, `v1,` prefix |
| Key | Secret string used as is | Base64-decoded bytes after `whsec_` | Same as Standard Webhooks |
| Tolerance | 300 s, past only in stripe-node (`timestampAge > tolerance`) | Spec says "some tolerance"; reference JS library uses 300 s both directions | 300 s both directions |
| Event id | Inside the body only | Signed header | Signed header |
| Rotation | Several `v1=` entries while an old secret is rolled; old secret can stay valid for a period (about 24 h, unverified) | Space-separated signatures, one per live secret | 0 to 72 h overlap, revoke-now option |
| Redirects | Not verified | 3xx is a failure | 3xx is a failure |
| SSRF | Not documented; maintains smokescreen | Filtering proxy or isolated subnet | In-process connect-time guard |
| Asymmetric | No | `v1a` with ed25519, recommended | Not in v1 (section 6) |

**The main design difference.** Stripe signs only `timestamp.body`; the event
id is trusted because it is inside the signed body. Standard Webhooks signs
the id separately so receivers can dedupe from headers before parsing JSON.
Dispatchly takes the Standard Webhooks route, which is also what lets
receivers use the official library.

Sources:
[Standard Webhooks spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
[reference JS library](https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/index.ts),
[stripe-node Webhooks.ts](https://github.com/stripe/stripe-node/blob/master/src/Webhooks.ts).
The Stripe rotation window has not been checked against Stripe's docs.

## 6. Build order and scope

Build the pure, testable pieces first, so the worker only calls them.

1. `src/security/signing.ts`: `sign(id, ts, body, secrets[])` and
   `verify(headers, body, secrets[], { now })`. Pure functions,
   cross-tested against `standardwebhooks`. Add `"test": "node --test"` to
   package.json.
2. `src/security/ssrf.ts`: IP classifier on `net.BlockList`,
   `validateEndpointUrl()` for registration, and a guarded undici `Agent` for
   delivery. Replace `z.string().url()` with `validateEndpointUrl()` in
   `src/routes/endpoints.ts`.
3. Worker delivery: re-check the URL host, load live secrets, serialize once,
   sign, `fetch` with the guarded agent, `redirect: "manual"`, timeouts,
   64 KB response cap.
4. Rotation: the partial unique index in `db/schema.sql`, the rotate route,
   expired-secret cleanup.
5. Secrets encrypted at rest, with a migration that encrypts existing rows
   (built).
6. Receiver example (`examples/receiver.ts`) using the official library plus a
   `processed_webhooks` table, and the curl replay demo.
7. `THREAT_MODEL.md`: the summary table, the two attackers, and what each
   mechanism does not cover.

**Out of scope for now (what to do at scale):** a smokescreen egress proxy,
`v1a` ed25519 signatures (receivers would need key distribution), mTLS to
receivers, and a cloud KMS for the encryption key.

## 7. Design questions

- **Why sign the timestamp and id, not just the body?** Otherwise an attacker
  pastes fresh headers onto an old body and replay protection is gone.
- **Why re-sign on every retry?** The receiver's window is 5 minutes and
  retries span days; the id stays stable, so dedupe still works.
- **Why is checking the URL at registration not enough?** DNS can return a
  different IP later (rebinding), so the check has to run on the IP the socket
  actually connects to.
- **Why does the URL host need its own check at delivery?** Node skips
  `lookup` for IP literals, so a lookup-only guard lets `http://127.0.0.1`
  through.
- **Why `timingSafeEqual`?** A normal compare returns early and leaks, through
  timing, how many leading bytes of a guess were correct.
- **How does rotation avoid dropping events?** Sign with every live secret
  during an overlap; the receiver switches whenever, and a partial unique
  index guarantees one current secret.
- **Why encrypt secrets instead of hashing them?** HMAC needs the raw key, so
  storage must be reversible.
- **Why GCM and not AES-CBC?** GCM is authenticated: a modified ciphertext
  fails to decrypt instead of decrypting to garbage the code then trusts.
  CBC would need a separate HMAC to get that.
- **Why a random nonce per secret?** Reusing a GCM nonce under the same key
  leaks the XOR of the two plaintexts and lets an attacker forge tags.
- **What does encryption at rest actually protect?** A leaked dump, backup
  or read-only database credential. Not a compromised server, because the key
  is in the same environment as the database URL.
