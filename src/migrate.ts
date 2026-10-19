import type pg from "pg";
import { readdir, readFile } from "node:fs/promises";

// Schema migrations, safe to run on every boot.
//
// db/schema.sql is the baseline: applied once to an empty database and never
// edited after the first deploy. Later changes are numbered files in
// db/migrations (0001_add_x.sql, ...), applied in name order. Each file runs
// in its own transaction together with the row that records it, so a failed
// migration leaves nothing half-applied and is retried on the next run.
//
// Paths are relative to this file, which sits one level below the repo root
// in both src/ and dist/.
const SCHEMA_FILE = new URL("../db/schema.sql", import.meta.url);
const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);
const BASELINE = "0000_schema.sql";

// Any constant works; it only has to be the same in every process. Two
// deploys starting at once take turns instead of racing on CREATE TABLE.
// Session-level advisory locks need a direct connection: through a
// transaction-mode pooler (Neon's "-pooler" host) the lock and the
// migration can land on different server connections.
const LOCK_KEY = 4_172_026;

export async function migrate(
  pool: pg.Pool,
  opts: { migrationsDir?: URL; log?: (msg: string) => void } = {}
): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        TEXT PRIMARY KEY,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));

    const pending: { name: string; sql: () => Promise<string> }[] = [];
    if (!done.has(BASELINE)) {
      // A database loaded by hand before this runner existed (docker compose
      // runs schema.sql on a fresh volume) already has the baseline. Record
      // it instead of failing on CREATE TABLE.
      const { rows: existing } = await client.query<{ found: boolean }>(
        "SELECT to_regclass('public.events') IS NOT NULL AS found"
      );
      if (existing[0].found) {
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [BASELINE]);
        log(`${BASELINE}: schema already present, recorded as applied`);
      } else {
        pending.push({ name: BASELINE, sql: () => readFile(SCHEMA_FILE, "utf8") });
      }
    }
    const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
    for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if (!done.has(name)) pending.push({ name, sql: () => readFile(new URL(name, dir), "utf8") });
    }

    for (const m of pending) {
      const sql = await m.sql();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
      log(`${m.name}: applied`);
    }
    return pending.map((m) => m.name);
  } finally {
    // Closing the session would release the lock too, but the pool keeps
    // the connection open.
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
