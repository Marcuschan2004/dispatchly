import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { pool } from "../src/db.js";

test("a dropped idle connection does not crash the process", async () => {
  const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

  // Kill the now-idle pooled client from outside, like Neon scaling to zero.
  const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await killer.connect();
  await killer.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
  await killer.end();
  await new Promise((r) => setTimeout(r, 300));

  // Without pool.on('error') the process would already be dead.
  const after = await pool.query("SELECT 1 AS ok");
  assert.equal(after.rows[0].ok, 1);
  await pool.end();
});
