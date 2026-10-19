import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { DeliveryWorker, workerConfig, type WorkerConfig } from "../src/delivery/worker.js";
import { signatureHeader } from "../src/delivery/signing.js";
import {
  createDelivery,
  createTestDatabase,
  localPolicy,
  localPolicyEnv,
  resetTables,
  sleep,
  startReceiver,
  testDatabaseUrl,
  waitFor,
} from "./helpers.js";

// Short lease and timeout so crash tests run in seconds.
const FAST = {
  leaseMs: 2000,
  requestTimeoutMs: 1000,
  backoffBaseMs: 1000,
  backoffCapMs: 10_000,
  maxAttempts: 3,
  maxIdleMs: 100,
};

const quiet = () => {};

let pool: pg.Pool;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

function makeWorker(id: string, overrides: Partial<WorkerConfig> = {}) {
  return new DeliveryWorker(pool, workerConfig({ ...FAST, ...overrides }), {
    id,
    egressPolicy: localPolicy(receiver.url),
    log: quiet,
  });
}

async function delivery(id: string) {
  const { rows } = await pool.query(`SELECT * FROM deliveries WHERE id = $1`, [id]);
  return rows[0];
}

async function attempts(deliveryId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id`,
    [deliveryId]
  );
  return rows;
}

// Runs src/worker.ts as a real OS process, so it can be SIGKILLed or SIGSTOPped.
function spawnWorker(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../src/worker.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        ...localPolicyEnv(receiver.url),
        WORKER_LEASE_MS: String(FAST.leaseMs),
        WORKER_REQUEST_TIMEOUT_MS: String(FAST.requestTimeoutMs),
        WORKER_MAX_ATTEMPTS: String(FAST.maxAttempts),
        WORKER_MAX_IDLE_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGKILL" && signal !== "SIGTERM") {
      console.error(`worker child exited ${code ?? signal}:\n${output}`);
    }
  });
  return child;
}

before(async () => {
  pool = await createTestDatabase();
  receiver = await startReceiver();
});

after(async () => {
  await receiver.close();
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
  receiver.received.length = 0;
  receiver.respond((_req, res) => res.writeHead(200).end("ok"));
});

describe("delivery", () => {
  test("delivers a signed webhook and records the attempt", async () => {
    const { deliveryId, eventId, secret } = await createDelivery(pool, receiver.url, {
      order_id: 42,
    });
    const worker = makeWorker("w1");

    assert.equal(await worker.tick(), 1);

    const d = await delivery(deliveryId);
    assert.equal(d.status, "delivered");
    assert.equal(d.attempts, 1);
    assert.equal(d.claim_token, null);
    assert.equal(d.last_status_code, 200);

    const [a] = await attempts(deliveryId);
    assert.equal(a.outcome, "delivered");
    assert.equal(a.worker_id, "w1");
    assert.equal(a.status_code, 200);
    assert.equal(a.response_snippet, "ok");
    assert.ok(a.finished_at);

    const [req] = receiver.received;
    assert.equal(req.headers["webhook-id"], eventId);
    const body = JSON.parse(req.body);
    assert.equal(body.type, "order.paid");
    assert.deepEqual(body.data, { order_id: 42 });
    const expected = signatureHeader(
      [secret],
      eventId,
      Number(req.headers["webhook-timestamp"]),
      req.body
    );
    assert.equal(req.headers["webhook-signature"], expected);
  });

  test("retries with backoff, then dead-letters after maxAttempts", async () => {
    receiver.respond((_req, res) => res.writeHead(500).end("boom"));
    const { deliveryId, eventId } = await createDelivery(pool, receiver.url);
    const worker = makeWorker("w1");

    for (let attempt = 1; attempt <= FAST.maxAttempts; attempt++) {
      assert.equal(await worker.tick(), 1, `attempt ${attempt} claimed`);
      const d = await delivery(deliveryId);
      assert.equal(d.attempts, attempt);
      assert.equal(d.last_status_code, 500);
      if (attempt < FAST.maxAttempts) {
        assert.equal(d.status, "pending");
        // Next try is scheduled no later than the backoff ceiling for this attempt.
        const { rows } = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000 AS ms
           FROM deliveries WHERE id = $1`,
          [deliveryId]
        );
        const ceiling = Math.min(FAST.backoffCapMs, FAST.backoffBaseMs * 2 ** (attempt - 1));
        assert.ok(Number(rows[0].ms) <= ceiling, `delay ${rows[0].ms} > ${ceiling}`);
        // Not due yet, so nothing to claim.
        if (Number(rows[0].ms) > 100) assert.equal(await worker.tick(), 0);
        // Fast-forward instead of sleeping through the backoff.
        await pool.query(`UPDATE deliveries SET next_attempt_at = now() WHERE id = $1`, [
          deliveryId,
        ]);
      }
    }

    const d = await delivery(deliveryId);
    assert.equal(d.status, "dead");
    assert.equal(d.last_error, "HTTP 500");
    assert.deepEqual(
      (await attempts(deliveryId)).map((a) => a.outcome),
      ["retry", "retry", "dead"]
    );
    assert.equal(await worker.tick(), 0, "dead deliveries are never claimed");
    // Every attempt carried the same webhook-id so the receiver can dedupe.
    assert.deepEqual(
      new Set(receiver.received.map((r) => r.headers["webhook-id"])),
      new Set([eventId])
    );
  });

  test("times out a hanging receiver and schedules a retry", async () => {
    receiver.respond(() => {}); // never answers
    const { deliveryId } = await createDelivery(pool, receiver.url);
    const worker = makeWorker("w1");

    const started = Date.now();
    await worker.tick();
    assert.ok(Date.now() - started < FAST.requestTimeoutMs + 500);

    const d = await delivery(deliveryId);
    assert.equal(d.status, "pending");
    assert.equal(d.last_error, `timeout after ${FAST.requestTimeoutMs}ms`);
    const [a] = await attempts(deliveryId);
    assert.equal(a.outcome, "retry");
    assert.equal(a.status_code, null);
  });

  test("does not follow redirects", async () => {
    receiver.respond((_req, res) =>
      res.writeHead(302, { location: `${receiver.url}?followed=1` }).end()
    );
    const { deliveryId } = await createDelivery(pool, receiver.url);

    await makeWorker("w1").tick();

    assert.equal(receiver.received.length, 1, "the Location was never requested");
    const d = await delivery(deliveryId);
    assert.equal(d.status, "pending");
    assert.equal(d.last_error, "HTTP 302 (redirects are not followed)");
  });

  test("honors Retry-After on 429 when it is longer than the backoff", async () => {
    receiver.respond((_req, res) => res.writeHead(429, { "retry-after": "5" }).end());
    const { deliveryId } = await createDelivery(pool, receiver.url);

    await makeWorker("w1").tick();

    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000 AS ms
       FROM deliveries WHERE id = $1`,
      [deliveryId]
    );
    // Backoff ceiling for attempt 1 is 1s; Retry-After pushes it to ~5s.
    assert.ok(Number(rows[0].ms) > 4000, `next attempt in ${rows[0].ms}ms`);
  });

  test("rejects non-http schemes before sending", async () => {
    const { deliveryId } = await createDelivery(pool, "file:///etc/passwd");
    await makeWorker("w1").tick();
    const d = await delivery(deliveryId);
    assert.equal(d.status, "pending");
    assert.equal(d.last_error, "scheme file: is not allowed; use http or https");
  });
});

describe("claiming", () => {
  test("concurrent workers never claim the same delivery", async () => {
    // Slow receiver so claims overlap with in-flight requests.
    receiver.respond((_req, res) => setTimeout(() => res.writeHead(200).end(), 20));
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push((await createDelivery(pool, receiver.url)).deliveryId);

    const workers = [1, 2, 3, 4].map((n) => makeWorker(`w${n}`, { concurrency: 5 }));
    while (true) {
      const claimed = await Promise.all(workers.map((w) => w.tick()));
      if (claimed.every((n) => n === 0)) break;
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, sum(attempts)::int AS attempts,
              count(DISTINCT a.worker_id)::int AS workers
       FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id
       WHERE d.status = 'delivered'`
    );
    assert.equal(rows[0].n, 60, "every delivery delivered");
    assert.equal(rows[0].attempts, 60, "each exactly once");
    assert.ok(rows[0].workers > 1, "work was spread across workers");
    assert.equal(receiver.received.length, 60, "receiver saw no duplicates");
  });

  test("a claimed row is not reclaimed while its lease is live", async () => {
    receiver.respond(() => {}); // hold the request open
    await createDelivery(pool, receiver.url);
    const a = makeWorker("a");
    const b = makeWorker("b");

    const inFlight = a.tick();
    await waitFor("request to arrive", async () => receiver.received.length === 1);
    assert.equal(await b.tick(), 0);
    await inFlight;
  });
});

describe("crash recovery", () => {
  test("a SIGKILLed worker's delivery is reclaimed after its lease expires", async () => {
    // First request hangs, standing in for a worker that dies mid-delivery.
    receiver.respond((_req, res, i) => {
      if (i > 0) res.writeHead(200).end("ok");
    });
    const { deliveryId, eventId } = await createDelivery(pool, receiver.url);

    const child = spawnWorker();
    await waitFor("child to send", async () => receiver.received.length === 1);
    const [claim] = await attempts(deliveryId);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    // Dead worker, live lease: nobody may take the row yet.
    const survivor = makeWorker("survivor");
    assert.equal(await survivor.tick(), 0, "lease still held by the dead worker");

    // Once the lease expires the survivor picks it up.
    const reclaimedAt = await waitFor("reclaim", async () =>
      (await survivor.tick()) === 1 ? Date.now() : null
    );
    const claimedAt = new Date(claim.started_at).getTime();
    assert.ok(reclaimedAt - claimedAt >= FAST.leaseMs - 100, "not reclaimed before expiry");

    const d = await delivery(deliveryId);
    assert.equal(d.status, "delivered");
    assert.equal(d.attempts, 2, "the crash cost one attempt");

    const [crashed, retried] = await attempts(deliveryId);
    assert.equal(crashed.outcome, "lease_expired");
    assert.equal(crashed.finished_at, null, "the crashed attempt never finished");
    assert.notEqual(crashed.worker_id, "survivor");
    assert.equal(retried.outcome, "delivered");
    assert.equal(retried.worker_id, "survivor");

    // At-least-once: the receiver saw the event twice, with one webhook-id to dedupe on.
    assert.equal(receiver.received.length, 2);
    assert.ok(receiver.received.every((r) => r.headers["webhook-id"] === eventId));
  });

  test("a stalled worker that wakes after losing its lease cannot overwrite the result", async () => {
    receiver.respond((_req, res, i) => {
      if (i > 0) res.writeHead(200).end("ok");
    });
    const { deliveryId } = await createDelivery(pool, receiver.url);

    const child = spawnWorker();
    await waitFor("child to send", async () => receiver.received.length === 1);
    child.kill("SIGSTOP"); // a long GC pause, or a VM being suspended

    try {
      const survivor = makeWorker("survivor");
      await waitFor("reclaim", async () => (await survivor.tick()) === 1);
      assert.equal((await delivery(deliveryId)).status, "delivered");

      // The stalled worker resumes, its request times out, and it tries to
      // record a retry. The claim_token fence turns that into a no-op.
      child.kill("SIGCONT");
      const stale = await waitFor("stale worker to record its attempt", async () => {
        const [first] = await attempts(deliveryId);
        return first.finished_at ? first : null;
      });
      assert.equal(stale.outcome, "lease_expired");
      assert.match(stale.error, /timeout/);

      const d = await delivery(deliveryId);
      assert.equal(d.status, "delivered", "stale write did not flip it back to pending");
      assert.equal(d.attempts, 2);
      assert.equal(d.last_status_code, 200);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  });

  test("a crash during the final attempt dead-letters once the lease expires", async () => {
    receiver.respond(() => {});
    const { deliveryId } = await createDelivery(pool, receiver.url);
    // Two failed attempts already; the child makes the last allowed one.
    await pool.query(`UPDATE deliveries SET attempts = $1 WHERE id = $2`, [
      FAST.maxAttempts - 1,
      deliveryId,
    ]);

    const child = spawnWorker();
    await waitFor("child to send", async () => receiver.received.length === 1);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    const survivor = makeWorker("survivor");
    await waitFor("dead-letter", async () => {
      await survivor.tick();
      return (await delivery(deliveryId)).status === "dead";
    });

    const d = await delivery(deliveryId);
    assert.equal(d.attempts, FAST.maxAttempts);
    assert.match(d.last_error, /did not finish before its lease expired/);
    const [a] = await attempts(deliveryId);
    assert.equal(a.outcome, "lease_expired");
    assert.equal(receiver.received.length, 1, "never sent again");
  });
});

describe("idle behavior", () => {
  test("sleeps until woken instead of polling, and wakes for new work", async () => {
    const worker = makeWorker("w1", { maxIdleMs: 60_000 });
    let queries = 0;
    const realQuery = pool.query.bind(pool);
    (pool as any).query = (...args: any[]) => {
      queries++;
      return (realQuery as any)(...args);
    };
    try {
      worker.start();
      await sleep(300);
      const idleQueries = queries;
      await sleep(1000);
      assert.equal(queries, idleQueries, "no queries while idle");

      await createDelivery(pool, receiver.url);
      worker.wake();
      await waitFor("delivery", async () => receiver.received.length === 1, 2000);
    } finally {
      (pool as any).query = realQuery;
      await worker.stop();
    }
  });

  test("wakes on its own when a retry comes due", async () => {
    receiver.respond((_req, res, i) => res.writeHead(i === 0 ? 500 : 200).end());
    const { deliveryId } = await createDelivery(pool, receiver.url);
    const worker = makeWorker("w1", { maxIdleMs: 60_000, backoffBaseMs: 500 });
    worker.start();
    try {
      await waitFor("retry to succeed", async () =>
        (await delivery(deliveryId)).status === "delivered"
      , 5000);
      assert.equal(receiver.received.length, 2);
    } finally {
      await worker.stop();
    }
  });
});
