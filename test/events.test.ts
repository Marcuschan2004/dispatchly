import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { createTestDatabase, resetTables } from "./helpers.js";

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  pool = await createTestDatabase();
  app = await buildApp({ pool, authDisabled: true });
});

after(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
});

const postEvent = (body: unknown, key: string) =>
  app.inject({
    method: "POST",
    url: "/events",
    headers: { "idempotency-key": key },
    payload: body as object,
  });

async function eventCount(key: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM events WHERE idempotency_key = $1`,
    [key]
  );
  return rows[0].n;
}

describe("Idempotency-Key", () => {
  test("a retry with the same body returns the original event", async () => {
    const first = await postEvent({ type: "order.paid", payload: { order_id: 1 } }, "k1");
    assert.equal(first.statusCode, 201);
    const again = await postEvent({ type: "order.paid", payload: { order_id: 1 } }, "k1");
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().event_id, first.json().event_id);
  });

  test("key order and whitespace in the payload don't count as a different body", async () => {
    const first = await postEvent({ type: "t", payload: { a: 1, b: { c: [1, 2] } } }, "k2");
    assert.equal(first.statusCode, 201);
    const again = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "idempotency-key": "k2", "content-type": "application/json" },
      payload: '{ "payload": { "b": { "c": [1, 2] }, "a": 1 }, "type": "t" }',
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().event_id, first.json().event_id);
  });

  test("the same key with a different payload is rejected with 422", async () => {
    const first = await postEvent({ type: "order.paid", payload: { order_id: 1 } }, "k3");
    assert.equal(first.statusCode, 201);
    const reused = await postEvent({ type: "order.paid", payload: { order_id: 2 } }, "k3");
    assert.equal(reused.statusCode, 422);
    assert.equal(reused.json().event_id, undefined);
    assert.equal(await eventCount("k3"), 1);
  });

  test("the same key with a different type is rejected with 422", async () => {
    await postEvent({ type: "order.paid", payload: { order_id: 1 } }, "k4");
    const reused = await postEvent({ type: "order.refunded", payload: { order_id: 1 } }, "k4");
    assert.equal(reused.statusCode, 422);
    assert.equal(await eventCount("k4"), 1);
  });

  test("concurrent requests with one key and different bodies: one 201, the rest 422", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => postEvent({ type: "t", payload: { i } }, "k5"))
    );
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [201, ...Array(9).fill(422)]);
    assert.equal(await eventCount("k5"), 1);
  });
});
