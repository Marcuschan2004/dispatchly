import type pg from "pg";
import { randomBytes } from "node:crypto";
import type { SecretCipher } from "./encryption.js";

// Standard Webhooks secret format: "whsec_" + base64 of random bytes.
export function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

// Each live secret adds a signature to every delivery's header. Three is
// enough for "current + one or two being phased out" and stops a rotate loop
// from bloating headers.
export const MAX_LIVE_SECRETS = 3;
export const MAX_OVERLAP_HOURS = 72;

export type RotateResult =
  | { kind: "rotated"; id: string; secret: string; created_at: Date; previous: SecretInfo[] }
  | { kind: "not_found" }
  | { kind: "too_many_live"; live: number };

export interface SecretInfo {
  id: string;
  created_at: Date;
  expires_at: Date | null;
}

// Makes a new current secret. Every older live secret expires after
// overlapHours (never later than it already would), and deliveries are signed
// with all of them until then, so a receiver can switch secrets at any point
// in the window without failing a delivery. overlapHours = 0 is the
// leaked-secret case: all older secrets stop working immediately.
export async function rotateSecret(
  pool: pg.Pool,
  cipher: SecretCipher,
  endpointId: string,
  overlapHours: number
): Promise<RotateResult> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");

    // Row lock on the endpoint: concurrent rotations of one endpoint run one
    // after another instead of each seeing the same "current" secret.
    const { rowCount } = await client.query(`SELECT 1 FROM endpoints WHERE id = $1 FOR UPDATE`, [
      endpointId,
    ]);
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    // Expired rows are dead weight; this is the only place they pile up, so
    // it's the only place that needs to clean them.
    await client.query(
      `DELETE FROM endpoint_secrets WHERE endpoint_id = $1 AND expires_at <= now()`,
      [endpointId]
    );

    const { rows: live } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM endpoint_secrets WHERE endpoint_id = $1`,
      [endpointId]
    );
    if (overlapHours > 0 && live[0].n >= MAX_LIVE_SECRETS) {
      await client.query("ROLLBACK");
      return { kind: "too_many_live", live: live[0].n };
    }

    const { rows: previous } = await client.query<SecretInfo>(
      `UPDATE endpoint_secrets
       SET expires_at = LEAST(COALESCE(expires_at, 'infinity'),
                              now() + $2::int * interval '1 hour')
       WHERE endpoint_id = $1
       RETURNING id, created_at, expires_at`,
      [endpointId, overlapHours]
    );

    const secret = newSecret();
    const { encrypted, keyVersion } = cipher.encrypt(secret, endpointId);
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO endpoint_secrets (endpoint_id, secret_encrypted, secret_key_version)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [endpointId, encrypted, keyVersion]
    );

    await client.query("COMMIT");
    return { kind: "rotated", id: rows[0].id, secret, created_at: rows[0].created_at, previous };
  } catch (err) {
    // If ROLLBACK fails too the connection is unusable; release(err) closes
    // it instead of handing it back to the pool.
    await client.query("ROLLBACK").catch((e: Error) => (broken = e));
    throw err;
  } finally {
    client.release(broken);
  }
}
