import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { migrate } from "../src/migrate.js";
import { testDatabaseUrl } from "./helpers.js";

// Its own database, so these tests can start from empty without touching
// the shared test database.
const url = new URL(testDatabaseUrl());
url.pathname = url.pathname.replace(/_test$/, "_migrate_test");

let pool: pg.Pool | null = null;
let dir: string | null = null;

async function emptyDatabase(): Promise<pg.Pool> {
  await pool?.end();
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const name = url.pathname.slice(1);
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  pool = new pg.Pool({ connectionString: url.toString() });
  return pool;
}

async function migrationsDir(files: Record<string, string>): Promise<URL> {
  dir = await mkdtemp(join(tmpdir(), "dispatchly-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return pathToFileURL(dir + "/");
}

async function applied(p: pg.Pool): Promise<string[]> {
  const { rows } = await p.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  return rows.map((r) => r.name);
}

beforeEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

after(async () => {
  await pool?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("loads the baseline on an empty database, then does nothing on later runs", async () => {
    const p = await emptyDatabase();
    const migrations = await migrationsDir({});
    assert.deepEqual(await migrate(p, { migrationsDir: migrations }), ["0000_schema.sql"]);
    assert.deepEqual(await migrate(p, { migrationsDir: migrations }), []);
    assert.deepEqual(await applied(p), ["0000_schema.sql"]);
    const { rows } = await p.query("SELECT to_regclass('public.deliveries') IS NOT NULL AS ok");
    assert.equal(rows[0].ok, true);
  });

  test("adopts a database whose schema was loaded by hand", async () => {
    const p = await emptyDatabase();
    await p.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    assert.deepEqual(await migrate(p, { migrationsDir: await migrationsDir({}) }), []);
    assert.deepEqual(await applied(p), ["0000_schema.sql"]);
  });

  test("applies numbered migrations in order, once each", async () => {
    const p = await emptyDatabase();
    const migrations = await migrationsDir({
      "0002_b.sql": "ALTER TABLE endpoints ADD COLUMN b INT NOT NULL DEFAULT 2;",
      "0001_a.sql": "ALTER TABLE endpoints ADD COLUMN a INT NOT NULL DEFAULT 1;",
      "notes.md": "not a migration",
    });
    assert.deepEqual(await migrate(p, { migrationsDir: migrations }), [
      "0000_schema.sql",
      "0001_a.sql",
      "0002_b.sql",
    ]);
    assert.deepEqual(await migrate(p, { migrationsDir: migrations }), []);
  });

  test("a failing migration is rolled back and retried on the next run", async () => {
    const p = await emptyDatabase();
    const migrations = await migrationsDir({
      "0001_bad.sql": "CREATE TABLE half_done (id INT); SELECT no_such_function();",
    });
    await assert.rejects(migrate(p, { migrationsDir: migrations }), /migration 0001_bad\.sql failed/);
    // The baseline before it committed; the bad file left nothing behind.
    assert.deepEqual(await applied(p), ["0000_schema.sql"]);
    const { rows } = await p.query("SELECT to_regclass('public.half_done') IS NULL AS gone");
    assert.equal(rows[0].gone, true);

    await writeFile(new URL("0001_bad.sql", migrations), "CREATE TABLE half_done (id INT);");
    assert.deepEqual(await migrate(p, { migrationsDir: migrations }), ["0001_bad.sql"]);
  });

  test("two deploys starting at once apply the schema exactly once", async () => {
    const p = await emptyDatabase();
    const migrations = await migrationsDir({});
    const results = await Promise.all([
      migrate(p, { migrationsDir: migrations }),
      migrate(p, { migrationsDir: migrations }),
    ]);
    assert.deepEqual(results.flat(), ["0000_schema.sql"]);
    assert.deepEqual(await applied(p), ["0000_schema.sql"]);
  });
});
