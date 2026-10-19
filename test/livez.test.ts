import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { buildApp } from "../src/app.js";

test("/livez answers without touching the database; /health does", async () => {
  let queries = 0;
  const pool = {
    query: async () => {
      queries++;
      throw new Error("database is asleep");
    },
  } as unknown as pg.Pool;
  // Auth on: the key lookup would query too, so /livez must skip it.
  const app = await buildApp({ pool });

  const live = await app.inject({ method: "GET", url: "/livez" });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { ok: true });
  assert.equal(queries, 0);

  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 500);
  assert.equal(queries, 1);
  await app.close();
});
