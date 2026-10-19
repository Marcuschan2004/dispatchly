import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import {
  SecretCipher,
  checkSecretsReadable,
  encryptPlaintextSecrets,
  secretCipherFromEnv,
} from "../src/security/encryption.js";
import { verifyWebhook } from "../src/security/signing.js";
import {
  createTestDatabase,
  localPolicy,
  resetTables,
  startReceiver,
  testCipher,
  testDatabaseUrl,
  waitFor,
} from "./helpers.js";

const KEY = randomBytes(32);
const cipher = new SecretCipher(KEY, 1);
const SECRET = "whsec_" + randomBytes(32).toString("base64");
const ENDPOINT = randomUUID();

describe("SecretCipher", () => {
  test("round-trips a secret", () => {
    const stored = cipher.encrypt(SECRET, ENDPOINT);
    assert.equal(stored.keyVersion, 1);
    assert.equal(cipher.decrypt(stored, ENDPOINT), SECRET);
  });

  test("a fresh nonce per encryption: the same secret never encrypts the same way", () => {
    const a = cipher.encrypt(SECRET, ENDPOINT).encrypted;
    const b = cipher.encrypt(SECRET, ENDPOINT).encrypted;
    assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
    assert.notDeepEqual(a, b);
  });

  test("any modified byte fails to decrypt: nonce, ciphertext or tag", () => {
    const { encrypted } = cipher.encrypt(SECRET, ENDPOINT);
    for (const i of [0, 11, 12, encrypted.length - 17, encrypted.length - 1]) {
      const bad = Buffer.from(encrypted);
      bad[i] ^= 1;
      assert.throws(() => cipher.decrypt({ encrypted: bad, keyVersion: 1 }, ENDPOINT), `byte ${i}`);
    }
    assert.throws(
      () => cipher.decrypt({ encrypted: encrypted.subarray(0, 20), keyVersion: 1 }, ENDPOINT),
      /truncated/
    );
  });

  test("a ciphertext moved to another endpoint fails to decrypt", () => {
    const stored = cipher.encrypt(SECRET, ENDPOINT);
    assert.throws(() => cipher.decrypt(stored, randomUUID()));
  });

  test("the wrong key or key version fails to decrypt", () => {
    const stored = cipher.encrypt(SECRET, ENDPOINT);
    assert.throws(() => new SecretCipher(randomBytes(32), 1).decrypt(stored, ENDPOINT));
    assert.throws(
      () => new SecretCipher(KEY, 2).decrypt(stored, ENDPOINT),
      /key version 1, but the configured key is version 2/
    );
  });
});

describe("secretCipherFromEnv", () => {
  const key = KEY.toString("base64");

  test("uses SECRETS_ENCRYPTION_KEY and its version", () => {
    const c = secretCipherFromEnv({
      SECRETS_ENCRYPTION_KEY: key,
      SECRETS_ENCRYPTION_KEY_VERSION: "3",
    });
    assert.equal(c.keyVersion, 3);
    assert.equal(c.isDevKey, false);
    assert.equal(c.decrypt(c.encrypt(SECRET, ENDPOINT), ENDPOINT), SECRET);
    assert.equal(secretCipherFromEnv({ SECRETS_ENCRYPTION_KEY: key }).keyVersion, 1);
  });

  test("falls back to the dev key only on a loopback HOST", () => {
    assert.equal(secretCipherFromEnv({}).isDevKey, true);
    assert.equal(secretCipherFromEnv({ HOST: "::1" }).isDevKey, true);
    assert.throws(
      () => secretCipherFromEnv({ HOST: "0.0.0.0" }),
      /SECRETS_ENCRYPTION_KEY is required/
    );
  });

  test("rejects malformed keys and versions", () => {
    const bad = [
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      key.slice(0, -2) + "!=", // invalid base64 character
      KEY.toString("hex"),
    ];
    for (const k of bad) {
      assert.throws(
        () => secretCipherFromEnv({ SECRETS_ENCRYPTION_KEY: k }),
        /exactly 32 bytes/,
        k
      );
    }
    for (const v of ["0", "-1", "1.5", "abc"]) {
      assert.throws(
        () =>
          secretCipherFromEnv({ SECRETS_ENCRYPTION_KEY: key, SECRETS_ENCRYPTION_KEY_VERSION: v }),
        /positive integer/,
        v
      );
    }
  });
});

describe("secrets in the database", () => {
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  before(async () => {
    pool = await createTestDatabase();
    receiver = await startReceiver();
    app = await buildApp({ pool, authDisabled: true, egressPolicy: localPolicy(receiver.url) });
  });

  after(async () => {
    await app.close();
    await receiver.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetTables(pool);
    receiver.received.length = 0;
  });

  // Every representation of a secret that would let someone sign webhooks:
  // the whsec_ string, its base64 part, and the raw HMAC key bytes.
  function forms(secret: string): Buffer[] {
    const b64 = secret.replace(/^whsec_/, "");
    return [Buffer.from(secret), Buffer.from(b64), Buffer.from(b64, "base64")];
  }

  function containsAny(haystack: Buffer, secrets: string[]): boolean {
    return secrets.some((s) => forms(s).some((f) => haystack.includes(f)));
  }

  // Every column of every row, as Postgres renders it (bytea as hex), plus
  // the hex of each secret's forms, so encoding can't hide a match.
  async function tableText(): Promise<string> {
    const { rows } = await pool.query<{ t: string }>(`SELECT t::text AS t FROM endpoint_secrets t`);
    return rows.map((r) => r.t).join("\n");
  }

  function textContainsAny(text: string, secrets: string[]): boolean {
    return secrets.some((s) =>
      forms(s).some((f) => text.includes(f.toString()) || text.includes(f.toString("hex")))
    );
  }

  // The table's data file on disk, after a checkpoint flushes it. This sees
  // what a stolen disk or file-level backup would: dead row versions and
  // dropped columns included. Needs a superuser, which CI and the docker
  // compose database have.
  async function tableFile(): Promise<Buffer> {
    await pool.query("CHECKPOINT");
    const { rows } = await pool.query<{ f: Buffer }>(
      `SELECT pg_read_binary_file(pg_relation_filepath('endpoint_secrets')) AS f`
    );
    return rows[0].f;
  }

  async function createEndpoint(): Promise<{ id: string; secret: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: { url: receiver.url },
    });
    assert.equal(res.statusCode, 201);
    return res.json();
  }

  async function rotate(id: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/endpoints/${id}/secrets/rotate`,
      payload: { overlap_hours: 1 },
    });
    assert.equal(res.statusCode, 201);
    return res.json().secret;
  }

  test("the database never holds a plaintext secret, created or rotated", async () => {
    const secrets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id, secret } = await createEndpoint();
      secrets.push(secret, await rotate(id), await rotate(id));
    }
    assert.equal(textContainsAny(await tableText(), secrets), false, "table rows");
    assert.equal(containsAny(await tableFile(), secrets), false, "table file on disk");

    // The probe itself works: the same check finds a secret that is there.
    assert.equal(containsAny(Buffer.from(`x${secrets[0]}x`), secrets), true);
  });

  test("deliveries are signed with the decrypted secrets", async () => {
    const { id, secret: oldSecret } = await createEndpoint();
    const newSecret = await rotate(id);
    await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "order.paid", payload: {} },
    });

    const worker = new DeliveryWorker(pool, workerConfig({}), {
      egressPolicy: localPolicy(receiver.url),
      log: () => {},
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    const req = await waitFor("delivery", async () => receiver.received[0]);
    for (const secret of [oldSecret, newSecret]) {
      assert.doesNotThrow(() => verifyWebhook(req.headers, req.body, secret));
    }
  });

  test("a secret that can't be decrypted fails that attempt with a recorded error", async () => {
    const { id } = await createEndpoint();
    await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "order.paid", payload: {} },
    });
    const worker = new DeliveryWorker(pool, workerConfig({}), {
      egressPolicy: localPolicy(receiver.url),
      cipher: new SecretCipher(randomBytes(32), testCipher.keyVersion),
      log: () => {},
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    assert.equal(receiver.received.length, 0, "nothing is sent unsigned");
    const { rows } = await pool.query(
      `SELECT d.status, a.error FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id
       WHERE d.endpoint_id = $1`,
      [id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.match(rows[0].error, /authenticate/);
  });

  describe("startup check", () => {
    test("passes with the right key and with no secrets at all", async () => {
      await checkSecretsReadable(pool, testCipher);
      await createEndpoint();
      await checkSecretsReadable(pool, testCipher);
    });

    test("refuses a key that can't decrypt the stored secrets", async () => {
      await createEndpoint();
      await assert.rejects(
        checkSecretsReadable(pool, new SecretCipher(randomBytes(32), testCipher.keyVersion)),
        /cannot decrypt stored signing secrets/
      );
      await assert.rejects(
        checkSecretsReadable(pool, new SecretCipher(randomBytes(32), 7)),
        /configured key is version 7/
      );
    });

    test("waits out an unreachable database instead of exiting", async () => {
      let calls = 0;
      const flaky = {
        query: async (...args: Parameters<pg.Pool["query"]>) => {
          if (++calls === 1)
            throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          if (calls === 2)
            throw Object.assign(new Error("the database system is starting up"), { code: "57P03" });
          return pool.query(...args);
        },
      } as unknown as pg.Pool;
      const retries: string[] = [];
      await createEndpoint();
      await checkSecretsReadable(flaky, testCipher, {
        retryMs: 1,
        onRetry: (e) => retries.push(e.message),
      });
      assert.equal(retries.length, 2);

      // A real answer from the database is not retried.
      const missing = {
        query: async () => {
          throw Object.assign(new Error('relation "endpoint_secrets" does not exist'), {
            code: "42P01",
          });
        },
      } as unknown as pg.Pool;
      await assert.rejects(
        checkSecretsReadable(missing, testCipher, { retryMs: 1 }),
        /does not exist/
      );
    });

    test("the server refuses to start on a public HOST without a key", async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("../src/server.ts", import.meta.url))],
        {
          env: {
            ...process.env,
            DATABASE_URL: testDatabaseUrl(),
            HOST: "0.0.0.0",
            PORT: "0",
            AUTH_DISABLED: "",
            SECRETS_ENCRYPTION_KEY: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const code = await new Promise((resolve) => child.on("exit", resolve));
      assert.notEqual(code, 0);
      assert.match(output, /SECRETS_ENCRYPTION_KEY is required/);
    });
  });

  describe("migrating a plaintext database", () => {
    // Turns the table back into its shape before encryption, with plaintext
    // secrets in it.
    async function plaintextTable(): Promise<{ endpointId: string; secrets: string[] }[]> {
      await pool.query(
        `TRUNCATE endpoints, events CASCADE;
         ALTER TABLE endpoint_secrets
           DROP COLUMN secret_encrypted, DROP COLUMN secret_key_version,
           ADD COLUMN secret TEXT NOT NULL`
      );
      const endpoints = [];
      for (const n of [1, 2]) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO endpoints (url) VALUES ($1) RETURNING id`,
          [receiver.url]
        );
        const secrets = [];
        for (let i = 0; i < n; i++) {
          const secret = "whsec_" + randomBytes(32).toString("base64");
          await pool.query(
            `INSERT INTO endpoint_secrets (endpoint_id, secret, expires_at)
             VALUES ($1, $2, CASE WHEN $3 THEN NULL ELSE now() + interval '1 hour' END)`,
            [rows[0].id, secret, i === n - 1]
          );
          secrets.push(secret);
        }
        endpoints.push({ endpointId: rows[0].id, secrets });
      }
      return endpoints;
    }

    test("encrypts every row, drops the plaintext, and scrubs the data file", async () => {
      const endpoints = await plaintextTable();
      const all = endpoints.flatMap((e) => e.secrets);
      await assert.rejects(checkSecretsReadable(pool, testCipher), /npm run encrypt-secrets/);
      assert.equal(containsAny(await tableFile(), all), true, "plaintext on disk before");

      assert.equal(await encryptPlaintextSecrets(pool, testCipher), 3);

      const { rows: cols } = await pool.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'endpoint_secrets' AND column_name LIKE 'secret%' ORDER BY 1`
      );
      assert.deepEqual(cols, [
        { column_name: "secret_encrypted", is_nullable: "NO" },
        { column_name: "secret_key_version", is_nullable: "NO" },
      ]);
      assert.equal(textContainsAny(await tableText(), all), false, "table rows after");
      assert.equal(containsAny(await tableFile(), all), false, "table file on disk after");
      await checkSecretsReadable(pool, testCipher);

      // Each endpoint still signs with exactly the secrets it had.
      for (const { endpointId, secrets } of endpoints) {
        const { rows } = await pool.query(
          `SELECT secret_encrypted, secret_key_version FROM endpoint_secrets
           WHERE endpoint_id = $1`,
          [endpointId]
        );
        const decrypted = rows.map((r) =>
          testCipher.decrypt(
            { encrypted: r.secret_encrypted, keyVersion: r.secret_key_version },
            endpointId
          )
        );
        assert.deepEqual(decrypted.sort(), [...secrets].sort());
      }

      // Running it again changes nothing.
      assert.equal(await encryptPlaintextSecrets(pool, testCipher), null);
    });

    test("a failure part way leaves the plaintext table untouched", async () => {
      const endpoints = await plaintextTable();
      let calls = 0;
      const failing = Object.assign(Object.create(testCipher), {
        encrypt(secret: string, endpointId: string) {
          if (++calls === 2) throw new Error("boom");
          return testCipher.encrypt(secret, endpointId);
        },
      }) as SecretCipher;
      await assert.rejects(encryptPlaintextSecrets(pool, failing), /boom/);

      const { rows } = await pool.query<{ secret: string }>(`SELECT secret FROM endpoint_secrets`);
      assert.deepEqual(
        rows.map((r) => r.secret).sort(),
        endpoints.flatMap((e) => e.secrets).sort()
      );
    });
  });
});
