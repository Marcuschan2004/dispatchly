import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type pg from "pg";
import { buildApp } from "../src/app.js";

function countingPool() {
  const pool = {
    queries: 0,
    query: async () => {
      pool.queries++;
      throw new Error("database is asleep");
    },
  };
  return pool;
}

test("GET / is public and never touches the database", async () => {
  const pool = countingPool();
  // Auth on, as in production: the key lookup would query, so "/" must skip it.
  const app = await buildApp({ pool: pool as unknown as pg.Pool });

  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /^text\/html/);
  assert.match(res.body, /<title>Dispatchly/);
  assert.equal(pool.queries, 0);

  // Making "/" public didn't open anything else (rejected before any lookup).
  assert.equal((await app.inject({ method: "GET", url: "/endpoints" })).statusCode, 401);
  await app.close();
});

test("the page's CSP allows exactly its own inline style and script", async () => {
  const pool = countingPool();
  const app = await buildApp({ pool: pool as unknown as pg.Pool });
  const res = await app.inject({ method: "GET", url: "/" });
  await app.close();

  const csp = res.headers["content-security-policy"] as string;
  assert.ok(csp, "CSP header is set");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");

  // A browser hashes the exact text between the tags. If the page and the
  // policy drift apart, the page renders unstyled with a dead status badge.
  const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
  const styles = [...res.body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  assert.equal(scripts.length, 1);
  assert.ok(csp.includes(`style-src ${hash(styles[0])}`), "style hash matches");
  assert.ok(csp.includes(`script-src ${hash(scripts[0])}`), "script hash matches");
});
