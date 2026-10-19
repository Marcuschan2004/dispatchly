import type pg from "pg";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LOOPBACK_HOSTS } from "../auth/api-keys.js";

// Signing secrets are encrypted at rest with AES-256-GCM. HMAC needs the raw
// secret, so it can't be hashed like an API key; it has to be reversible.
//
// Stored format (one BYTEA): nonce (12 bytes) || ciphertext || tag (16 bytes).
// The key version sits in its own column, so the database can say which rows
// still use an old key once the key is rotated.
//
// What this protects: a leaked backup, SQL dump or read-only database
// credential. What it doesn't: anyone who can read the server's environment,
// since the key lives there next to DATABASE_URL.

const NONCE_BYTES = 12; // GCM's standard nonce size
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

// Used only when no key is configured and the server is bound to loopback,
// so local dev and tests work without setup. It is public, so it protects
// nothing; version 0 keeps rows written with it from ever being mistaken for
// rows written with a real key.
const DEV_KEY = Buffer.alloc(KEY_BYTES, "dispatchly-dev-key-not-a-secret!");
const DEV_KEY_VERSION = 0;

export interface EncryptedSecret {
  encrypted: Buffer;
  keyVersion: number;
}

export class SecretCipher {
  constructor(
    private readonly key: Buffer,
    readonly keyVersion: number
  ) {
    if (key.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
  }

  get isDevKey(): boolean {
    return this.keyVersion === DEV_KEY_VERSION;
  }

  // `endpointId` is bound in as additional authenticated data: a ciphertext
  // copied onto another endpoint's row fails to decrypt instead of making that
  // endpoint sign with someone else's secret.
  encrypt(secret: string, endpointId: string): EncryptedSecret {
    // A fresh random nonce per secret. Reusing a nonce under one GCM key
    // leaks the XOR of the two plaintexts and lets an attacker forge tags.
    // Random 96-bit nonces are safe for far more secrets than this will hold.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(endpointId));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      encrypted: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(stored: EncryptedSecret, endpointId: string): string {
    if (stored.keyVersion !== this.keyVersion) {
      throw new Error(
        `signing secret is encrypted with key version ${stored.keyVersion}, ` +
          `but the configured key is version ${this.keyVersion}`
      );
    }
    const { encrypted } = stored;
    if (encrypted.length < NONCE_BYTES + TAG_BYTES)
      throw new Error("encrypted secret is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(endpointId));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES));
    // final() throws if the tag doesn't match: wrong key, wrong endpoint, or
    // a modified ciphertext. GCM never hands back unauthenticated plaintext.
    return Buffer.concat([
      decipher.update(encrypted.subarray(NONCE_BYTES, encrypted.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}

// SECRETS_ENCRYPTION_KEY is base64 of 32 random bytes:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// SECRETS_ENCRYPTION_KEY_VERSION (default 1) goes up by one each time the key
// is replaced.
export function secretCipherFromEnv(env = process.env): SecretCipher {
  const raw = env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    const host = env.HOST ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `SECRETS_ENCRYPTION_KEY is required when HOST is not loopback (HOST=${host})`
      );
    }
    return new SecretCipher(DEV_KEY, DEV_KEY_VERSION);
  }

  const key = Buffer.from(raw, "base64");
  // Buffer.from(..., "base64") skips invalid characters instead of failing,
  // so a typo'd key would silently become a different key. Round-tripping
  // catches that.
  if (key.length !== KEY_BYTES || key.toString("base64") !== raw) {
    throw new Error(`SECRETS_ENCRYPTION_KEY must be base64 of exactly ${KEY_BYTES} bytes`);
  }
  const version = Number(env.SECRETS_ENCRYPTION_KEY_VERSION ?? 1);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("SECRETS_ENCRYPTION_KEY_VERSION must be a positive integer");
  }
  return new SecretCipher(key, version);
}

// Run at startup, before serving or delivering anything. A wrong key would
// otherwise fail every delivery until they all dead-letter, and the API
// would store new secrets under it; this turns it into one clear error.
// Decrypting one row per key version is enough: every row with that version
// was written with the same key.
//
// If the database is unreachable (down, restarting, a scale-to-zero wake-up)
// it waits and tries again rather than exiting, so a process started during
// an outage comes up when the database does, as it did before this check.
export async function checkSecretsReadable(
  pool: pg.Pool,
  cipher: SecretCipher,
  opts: { retryMs?: number; onRetry?: (err: Error) => void } = {}
): Promise<void> {
  let rows: { endpoint_id: string; secret_encrypted: Buffer; secret_key_version: number }[];
  for (;;) {
    try {
      ({ rows } = await pool.query(
        `SELECT DISTINCT ON (secret_key_version) endpoint_id, secret_encrypted, secret_key_version
         FROM endpoint_secrets ORDER BY secret_key_version, created_at`
      ));
      break;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "42703") {
        throw new Error(
          "endpoint_secrets still holds plaintext secrets; run npm run encrypt-secrets"
        );
      }
      // A SQLSTATE outside connection exceptions (08) and shutdown/startup
      // (57P) is a real answer from the database, such as a missing table.
      if (/^[0-9A-Z]{5}$/.test(code) && !/^(08|57P)/.test(code)) throw err;
      (opts.onRetry ?? warnRetry)(err as Error);
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 2000));
    }
  }
  for (const row of rows) {
    try {
      cipher.decrypt(
        { encrypted: row.secret_encrypted, keyVersion: row.secret_key_version },
        row.endpoint_id
      );
    } catch (err) {
      throw new Error(
        `cannot decrypt stored signing secrets (key version ${row.secret_key_version}); ` +
          `is SECRETS_ENCRYPTION_KEY the key they were written with? ${(err as Error).message}`
      );
    }
  }
}

function warnRetry(err: Error): void {
  console.error(
    JSON.stringify({
      level: "warn",
      msg: "database unavailable; retrying the encryption key check",
      error: err.message,
    })
  );
}

// One-time migration for databases created before encryption: adds the
// encrypted columns, encrypts every plaintext secret and drops the plaintext
// column, all in one transaction, so a failure leaves the table as it was.
// Running it again is a no-op. Returns how many secrets it encrypted, or null
// if there was nothing to migrate.
export async function encryptPlaintextSecrets(
  pool: pg.Pool,
  cipher: SecretCipher
): Promise<number | null> {
  const client = await pool.connect();
  let broken: Error | undefined;
  let migrated: number | null = null;
  try {
    await client.query("BEGIN");
    // Lock first so no secret is inserted between reading and dropping.
    await client.query("LOCK TABLE endpoint_secrets IN ACCESS EXCLUSIVE MODE");
    const { rowCount } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'endpoint_secrets'
         AND column_name = 'secret'`
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `ALTER TABLE endpoint_secrets
         ADD COLUMN IF NOT EXISTS secret_encrypted BYTEA,
         ADD COLUMN IF NOT EXISTS secret_key_version INT`
    );
    const { rows } = await client.query<{ id: string; endpoint_id: string; secret: string }>(
      `SELECT id, endpoint_id, secret FROM endpoint_secrets`
    );
    for (const row of rows) {
      const { encrypted, keyVersion } = cipher.encrypt(row.secret, row.endpoint_id);
      await client.query(
        `UPDATE endpoint_secrets SET secret_encrypted = $2, secret_key_version = $3 WHERE id = $1`,
        [row.id, encrypted, keyVersion]
      );
    }
    await client.query(
      `ALTER TABLE endpoint_secrets
         DROP COLUMN secret,
         ALTER COLUMN secret_encrypted SET NOT NULL,
         ALTER COLUMN secret_key_version SET NOT NULL,
         ADD CHECK (octet_length(secret_encrypted) > 28)`
    );
    await client.query("COMMIT");
    migrated = rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch((e: Error) => (broken = e));
    throw err;
  } finally {
    client.release(broken);
  }

  // DROP COLUMN only hides the column, and the UPDATEs left the old row
  // versions behind, so the plaintext is still in the table's data file.
  // VACUUM FULL rewrites the table without dead rows and nulls out dropped
  // columns. It can't reach backups or WAL already written, so secrets that
  // were ever stored in plaintext should still be rotated.
  await pool.query("VACUUM FULL endpoint_secrets");
  return migrated;
}
