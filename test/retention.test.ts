import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { pruneDelivered, retentionConfig, startRetention } from "../src/retention.js";
import { createTestDatabase, resetTables } from "./helpers.js";

let pool: pg.Pool;

before(async () => {
  pool = await createTestDatabase();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
});

// One event, `ageDays` old, with one delivery per status given, each with
// one attempt row.
async function event(ageDays: number, statuses: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events (type, payload, idempotency_key, created_at)
     VALUES ('order.paid', '{}', gen_random_uuid()::text, now() - make_interval(days => $1))
     RETURNING id`,
    [ageDays]
  );
  const eventId = rows[0].id;
  for (const status of statuses) {
    await pool.query(
      `WITH ep AS (
         INSERT INTO endpoints (url) VALUES ('https://example.com/hook') RETURNING id
       ), d AS (
         INSERT INTO deliveries (event_id, endpoint_id, status, attempts)
         SELECT $1, id, $2, 1 FROM ep RETURNING id
       )
       INSERT INTO delivery_attempts (delivery_id, claim_token, attempt, worker_id, outcome)
       SELECT id, gen_random_uuid(), 1, 'test', NULL FROM d`,
      [eventId, status]
    );
  }
  return eventId;
}

async function remaining(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM events");
  return rows.map((r) => r.id);
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

describe("retention", () => {
  test("prunes old fully delivered events with their deliveries and attempts", async () => {
    const oldDelivered = await event(8, ["delivered", "delivered"]);
    const oldNoEndpoints = await event(8, []);
    const oldDead = await event(8, ["delivered", "dead"]);
    const oldPending = await event(8, ["pending"]);
    const recent = await event(6, ["delivered"]);

    const deleted = await pruneDelivered(pool, retentionConfig({ days: 7 }));

    assert.equal(deleted, 2);
    const left = await remaining();
    assert.ok(!left.includes(oldDelivered));
    assert.ok(!left.includes(oldNoEndpoints));
    assert.deepEqual(left.sort(), [oldDead, oldPending, recent].sort());
    // Kept: dead event (2 deliveries), pending (1), recent (1).
    assert.equal(await count("deliveries"), 4);
    assert.equal(await count("delivery_attempts"), 4);
  });

  test("deletes in batches until nothing is left to prune", async () => {
    for (let i = 0; i < 5; i++) await event(30, ["delivered"]);
    assert.equal(await pruneDelivered(pool, retentionConfig({ days: 7, batchSize: 2 })), 5);
    assert.equal(await count("events"), 0);
  });

  test("startRetention prunes on start; days = 0 turns it off", async () => {
    await event(30, ["delivered"]);
    await startRetention(pool, retentionConfig({ days: 0 }))();
    assert.equal(await count("events"), 1);

    const stop = startRetention(pool, retentionConfig({ days: 7 }));
    await stop(); // waits for the run that started immediately
    assert.equal(await count("events"), 0);
  });
});
