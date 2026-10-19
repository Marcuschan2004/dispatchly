import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { authDisabledFromEnv, createApiKey, hashApiKey } from "../src/auth/api-keys.js";
import { createTestDatabase, testDatabaseUrl } from "./helpers.js";

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  pool = await createTestDatabase();
  // A fixed public DNS answer, so registering example.com needs no network.
  app = await buildApp({
    pool,
    resolve: async () => [{ address: "93.184.215.14", family: 4 }],
  });
});

after(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE api_keys, endpoints, events CASCADE");
});

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const listEndpoints = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/endpoints", headers });

describe("API key auth", () => {
  test("every route except /health requires a key", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);

    const routes = [
      ["GET", "/endpoints"],
      ["POST", "/endpoints"],
      ["POST", "/events"],
      ["GET", "/deliveries?status=dead"],
      ["POST", `/deliveries/${randomUUID()}/replay`],
      ["POST", `/endpoints/${randomUUID()}/replay`],
      ["GET", "/no-such-route"],
    ] as const;
    for (const [method, url] of routes) {
      const res = await app.inject({ method, url, payload: {} });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.headers["www-authenticate"], 'Bearer realm="dispatchly"');
    }
    // Rejected before the handler ran: nothing was written.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM events");
    assert.equal(rows[0].n, 0);
  });

  test("a valid key gets through", async () => {
    const { key } = await createApiKey(pool, "test");
    const res = await app.inject({
      method: "POST",
      url: "/endpoints",
      headers: bearer(key),
      payload: { url: "https://example.com/hook" },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((await listEndpoints(bearer(key))).statusCode, 200);
  });

  test("wrong, malformed and non-Bearer credentials all get the same 401", async () => {
    const { key } = await createApiKey(pool, "test");
    const flipped = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    const attempts = [
      bearer(flipped),
      bearer("dk_short"),
      bearer(key + "x"),
      { authorization: key },
      { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      { authorization: `Bearer  ${key}` },
    ];
    for (const headers of attempts) {
      const res = await listEndpoints(headers);
      assert.equal(res.statusCode, 401, headers.authorization);
      assert.deepEqual(res.json(), { error: "missing or invalid API key" });
    }
  });

  test("a revoked key stops working on the next request", async () => {
    const { id, key } = await createApiKey(pool, "test");
    assert.equal((await listEndpoints(bearer(key))).statusCode, 200);
    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [id]);
    assert.equal((await listEndpoints(bearer(key))).statusCode, 401);
  });

  test("only a hash and a short prefix are stored", async () => {
    const { id, key, prefix } = await createApiKey(pool, "test");
    assert.match(key, /^dk_[A-Za-z0-9_-]{43}$/);
    assert.equal(prefix, key.slice(0, 11));
    const { rows } = await pool.query("SELECT * FROM api_keys WHERE id = $1", [id]);
    assert.deepEqual(rows[0].key_hash, hashApiKey(key));
    assert.ok(!JSON.stringify(rows[0]).includes(key.slice(11)));
  });

  test("last_used_at is set on use and not rewritten within a minute", async () => {
    const { id, key } = await createApiKey(pool, "test");
    const lastUsed = async () =>
      (await pool.query("SELECT last_used_at FROM api_keys WHERE id = $1", [id])).rows[0]
        .last_used_at as Date | null;

    assert.equal(await lastUsed(), null);
    await listEndpoints(bearer(key));
    const first = await lastUsed();
    assert.ok(first);
    await listEndpoints(bearer(key));
    assert.deepEqual(await lastUsed(), first);

    await pool.query(
      "UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1",
      [id]
    );
    await listEndpoints(bearer(key));
    assert.ok((await lastUsed())! > first);
  });
});

describe("AUTH_DISABLED", () => {
  test("turns auth off only on a loopback host", () => {
    assert.equal(authDisabledFromEnv({}), false);
    assert.equal(authDisabledFromEnv({ AUTH_DISABLED: "true" }), true);
    assert.equal(authDisabledFromEnv({ AUTH_DISABLED: "true", HOST: "::1" }), true);
    assert.throws(
      () => authDisabledFromEnv({ AUTH_DISABLED: "true", HOST: "0.0.0.0" }),
      /only allowed on a loopback HOST/
    );
    assert.equal(authDisabledFromEnv({ AUTH_DISABLED: "1", HOST: "0.0.0.0" }), false);
  });

  test("an app built with auth disabled needs no key", async () => {
    const open = await buildApp({ pool, authDisabled: true });
    try {
      assert.equal((await open.inject({ method: "GET", url: "/endpoints" })).statusCode, 200);
    } finally {
      await open.close();
    }
  });
});

describe("api-key CLI", () => {
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("../src/cli/api-keys.ts", import.meta.url)), ...args],
      { env: { ...process.env, DATABASE_URL: testDatabaseUrl() } }
    );

  test("create prints a working key; revoke by prefix disables it", async () => {
    const created = await run("create", "ci");
    const key = created.stdout.match(/dk_[A-Za-z0-9_-]{43}/)![0];
    assert.equal((await listEndpoints(bearer(key))).statusCode, 200);

    const listed = await run("list");
    assert.match(listed.stdout, /ci/);
    assert.ok(!listed.stdout.includes(key), "list must not print the full key");

    await run("revoke", key.slice(0, 11));
    assert.equal((await listEndpoints(bearer(key))).statusCode, 401);
  });
});
