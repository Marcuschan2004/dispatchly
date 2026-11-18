import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { createApiKey } from "../src/auth/api-keys.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import { createMetrics, type Metrics } from "../src/metrics.js";
import { createDelivery, createTestDatabase, localPolicy, resetTables, startReceiver } from "./helpers.js";

const quiet = () => {};

// Reads one sample from Prometheus text output, e.g.
// value(text, 'dispatchly_deliveries{status="dead"}').
function value(text: string, series: string): number {
  const line = text.split("\n").find((l) => l.startsWith(series + " "));
  assert.ok(line, `missing series ${series}`);
  return Number(line.slice(series.length + 1));
}

let pool: pg.Pool;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

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
  await pool.query("TRUNCATE api_keys");
  receiver.received.length = 0;
  receiver.respond((_req, res) => res.writeHead(200).end("ok"));
});

async function scrape(metrics: Metrics): Promise<string> {
  const app = await buildApp({ pool, authDisabled: true, metrics });
  const res = await app.inject({ method: "GET", url: "/metrics" });
  await app.close();
  assert.equal(res.statusCode, 200, res.body);
  return res.body;
}

function makeWorker(metrics: Metrics, maxAttempts = 3) {
  return new DeliveryWorker(
    pool,
    workerConfig({ leaseMs: 5000, requestTimeoutMs: 1000, maxAttempts, maxIdleMs: 100 }),
    { egressPolicy: localPolicy(receiver.url), log: quiet, metrics }
  );
}

describe("GET /metrics", () => {
  test("needs an API key and answers in Prometheus text format", async () => {
    const app = await buildApp({ pool, metrics: createMetrics(pool, { defaultMetrics: false }) });
    assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 401);

    const { key } = await createApiKey(pool, "prometheus");
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${key}` },
    });
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /^text\/plain; version=0\.0\.4/);
    assert.match(res.body, /# TYPE dispatchly_delivery_attempts_total counter/);
  });

  test("queue gauges are read from Postgres at scrape time", async () => {
    const metrics = createMetrics(pool, { defaultMetrics: false });
    const a = await createDelivery(pool, receiver.url);
    await createDelivery(pool, receiver.url);
    const c = await createDelivery(pool, receiver.url);
    await pool.query(`UPDATE deliveries SET status = 'dead' WHERE id = $1`, [c.deliveryId]);
    await pool.query(
      `UPDATE deliveries SET next_attempt_at = now() - interval '90 seconds' WHERE id = $1`,
      [a.deliveryId]
    );

    const text = await scrape(metrics);
    assert.equal(value(text, 'dispatchly_deliveries{status="pending"}'), 2);
    assert.equal(value(text, 'dispatchly_deliveries{status="dead"}'), 1);
    assert.equal(value(text, 'dispatchly_deliveries{status="delivered"}'), 0);
    assert.equal(value(text, "dispatchly_deliveries_due"), 2);
    const age = value(text, "dispatchly_oldest_due_delivery_age_seconds");
    assert.ok(age >= 90 && age < 120, `oldest due age ${age}`);
  });

  test("an empty queue reports zeros, not missing series", async () => {
    const text = await scrape(createMetrics(pool, { defaultMetrics: false }));
    assert.equal(value(text, "dispatchly_deliveries_due"), 0);
    assert.equal(value(text, "dispatchly_oldest_due_delivery_age_seconds"), 0);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="dead"}'), 0);
  });

  test("the worker counts outcomes and observes latency", async () => {
    const metrics = createMetrics(pool, { defaultMetrics: false });
    const worker = makeWorker(metrics, 1); // one attempt: a failure goes straight to dead
    const ok = await createDelivery(pool, receiver.url, { n: "ok" });
    await createDelivery(pool, receiver.url, { n: "fail" });
    receiver.respond((req, res) =>
      req.body.includes('"fail"') ? res.writeHead(500).end("boom") : res.writeHead(200).end("ok")
    );
    assert.equal(await worker.tick(), 2);
    await worker.stop();

    const text = await scrape(metrics);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="delivered"}'), 1);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="dead"}'), 1);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="retry"}'), 0);
    assert.equal(value(text, 'dispatchly_delivery_attempt_duration_seconds_count{result="success"}'), 1);
    assert.equal(value(text, 'dispatchly_delivery_attempt_duration_seconds_count{result="failure"}'), 1);
    // And the gauges agree with what the worker did.
    assert.equal(value(text, 'dispatchly_deliveries{status="delivered"}'), 1);
    assert.equal(value(text, 'dispatchly_deliveries{status="dead"}'), 1);
    const { rows } = await pool.query(`SELECT status FROM deliveries WHERE id = $1`, [ok.deliveryId]);
    assert.equal(rows[0].status, "delivered");
  });

  test("a result dropped by the claim_token fence counts as lease_lost, not delivered", async () => {
    const metrics = createMetrics(pool, { defaultMetrics: false });
    const worker = makeWorker(metrics);
    const { deliveryId } = await createDelivery(pool, receiver.url);
    // While the request is in flight, another worker "re-claims" the row.
    receiver.respond(async (_req, res) => {
      await pool.query(`UPDATE deliveries SET claim_token = gen_random_uuid() WHERE id = $1`, [
        deliveryId,
      ]);
      res.writeHead(200).end("ok");
    });
    await worker.tick();
    await worker.stop();

    const text = await scrape(metrics);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="lease_lost"}'), 1);
    assert.equal(value(text, 'dispatchly_delivery_attempts_total{outcome="delivered"}'), 0);
    assert.equal(value(text, 'dispatchly_deliveries{status="pending"}'), 1);
  });

  test("one scrape runs one queue query, however many gauges read it", async () => {
    let queries = 0;
    const counting = {
      query: async (sql: string, params?: unknown[]) => {
        queries++;
        return pool.query(sql, params);
      },
    } as unknown as pg.Pool;
    const metrics = createMetrics(counting, { defaultMetrics: false });
    await metrics.registry.metrics();
    assert.equal(queries, 1);
    await metrics.registry.metrics();
    assert.equal(queries, 2, "the next scrape reads fresh numbers");
  });

  test("a scrape fails loudly when Postgres is down instead of reporting zeros", async () => {
    const down = {
      query: async () => {
        throw new Error("database is asleep");
      },
    } as unknown as pg.Pool;
    const app = await buildApp({
      pool: down,
      authDisabled: true,
      metrics: createMetrics(down, { defaultMetrics: false }),
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    assert.equal(res.statusCode, 500);
  });
});
