import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { createHash, randomBytes } from "node:crypto";

// Key format: "dk_" + 43 chars of base64url (32 random bytes). The prefix
// makes keys easy to spot in a leaked file and lets secret scanners match
// them; the random part is what makes them unguessable.
const KEY_PREFIX = "dk_";
const KEY_PATTERN = /^dk_[A-Za-z0-9_-]{43}$/;
const DISPLAY_CHARS = 11; // "dk_" + 8 chars, enough to tell keys apart

export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, prefix: key.slice(0, DISPLAY_CHARS), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export async function createApiKey(pool: pg.Pool, name: string) {
  const { key, prefix, hash } = generateApiKey();
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (name, prefix, key_hash) VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [name, prefix, hash]
  );
  return { id: rows[0].id, name, prefix, key, created_at: rows[0].created_at };
}

// Returns the key id, or null for a missing, malformed, unknown or revoked
// key. The lookup is by hash through a unique index, so there is no string
// compare on the secret to time: an attacker controls the input, not the
// hash it maps to.
export async function authenticate(
  pool: pg.Pool,
  header: string | undefined
): Promise<string | null> {
  const match = header?.match(/^Bearer (\S+)$/);
  if (!match || !KEY_PATTERN.test(match[1])) return null;

  // last_used_at is written at most once a minute per key, so a busy client
  // doesn't turn every read into a write.
  const { rows } = await pool.query<{ id: string }>(
    `WITH k AS (
       SELECT id, last_used_at FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL
     ), touch AS (
       UPDATE api_keys a SET last_used_at = now()
       FROM k
       WHERE a.id = k.id
         AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
     )
     SELECT id FROM k`,
    [hashApiKey(match[1])]
  );
  return rows[0]?.id ?? null;
}

declare module "fastify" {
  interface FastifyRequest {
    apiKeyId: string | null;
  }
}

// Every route registered after this requires "Authorization: Bearer <key>",
// except the ones listed in `public`. One 401 for every failure, so a caller
// can't tell a revoked key from a typo.
export function requireApiKey(
  app: FastifyInstance,
  opts: { pool: pg.Pool; public: string[] }
): void {
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.public.includes(req.routeOptions.url ?? "")) return;
    const id = await authenticate(opts.pool, req.headers.authorization);
    if (!id) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="dispatchly"')
        .send({ error: "missing or invalid API key" });
    }
    req.apiKeyId = id;
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// AUTH_DISABLED=true exists so local scripts can call the API without a key.
// It only works on a loopback address: a server reachable from the network
// refuses to start without auth, so a copied .env can't open it up.
export function authDisabledFromEnv(env = process.env): boolean {
  const disabled = env.AUTH_DISABLED === "true";
  const host = env.HOST ?? "127.0.0.1";
  if (disabled && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`AUTH_DISABLED=true is only allowed on a loopback HOST, not ${host}`);
  }
  return disabled;
}
