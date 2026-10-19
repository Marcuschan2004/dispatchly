import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import { verifyWebhook } from "../src/security/signing.js";
import { createTestDatabase, localPolicy, resetTables, startReceiver } from "./helpers.js";

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let receiver: Awaited<ReturnType<typeof startReceiver>>;
let wakes = 0;

before(async () => {
  pool = await createTestDatabase();
  receiver = await startReceiver();
  app = await buildApp({
    pool,
    authDisabled: true,
    egressPolicy: localPolicy(receiver.url),
    onDeliveriesCreated: () => wakes++,
  });
});

after(async () => {
  await app.close();
  await receiver.close();
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
  receiver.received.length = 0;
  receiver.respond((_req, res) => res.writeHead(200).end("ok"));
  wakes = 0;
});

async function createEndpoint(): Promise<{ id: string; secret: string }> {
  const res = await app.inject({ method: "POST", url: "/endpoints", payload: { url: receiver.url } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

// Inserts one event and its delivery to `endpointId` directly, in whatever
// state the test needs.
async function addDelivery(
  endpointId: string,
  status: "pending" | "delivered" | "dead" = "dead",
  createdAt = new Date()
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH ev AS (
       INSERT INTO events (type, payload) VALUES ('order.paid', '{"n": 1}') RETURNING id
     )
     INSERT INTO deliveries (event_id, endpoint_id, status, attempts, last_status_code,
                             last_error, next_attempt_at, created_at)
     SELECT ev.id, $1, $2, 15, 500, 'HTTP 500', now() + interval '1 hour', $3 FROM ev
     RETURNING id`,
    [endpointId, status, createdAt]
  );
  return rows[0].id;
}

async function delivery(id: string) {
  const { rows } = await pool.query(`SELECT * FROM deliveries WHERE id = $1`, [id]);
  return rows[0];
}

async function statuses(endpointId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 GROUP BY status`,
    [endpointId]
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

const list = (query: string) => app.inject({ method: "GET", url: `/deliveries${query}` });
const replayOne = (id: string) => app.inject({ method: "POST", url: `/deliveries/${id}/replay` });
const replayAll = (endpointId: string, payload?: object) =>
  app.inject({ method: "POST", url: `/endpoints/${endpointId}/replay`, payload });

describe("GET /deliveries", () => {
  test("?status=dead lists dead deliveries, newest first, filtered by endpoint", async () => {
    const a = await createEndpoint();
    const b = await createEndpoint();
    const older = await addDelivery(a.id, "dead", new Date(Date.now() - 60_000));
    const newer = await addDelivery(a.id, "dead");
    const otherEndpoint = await addDelivery(b.id, "dead");
    await addDelivery(a.id, "delivered");
    await addDelivery(a.id, "pending");

    const all = await list("?status=dead");
    assert.equal(all.statusCode, 200);
    assert.deepEqual(
      new Set(all.json().data.map((d: { id: string }) => d.id)),
      new Set([older, newer, otherEndpoint])
    );

    const res = await list(`?status=dead&endpoint_id=${a.id}`);
    const { data, next_cursor } = res.json();
    assert.deepEqual(
      data.map((d: { id: string }) => d.id),
      [newer, older]
    );
    assert.equal(next_cursor, null);
    assert.equal(data[0].status, "dead");
    assert.equal(data[0].event_type, "order.paid");
    assert.equal(data[0].last_error, "HTTP 500");
    assert.equal(data[0].secret, undefined);
  });

  test("the cursor pages through every row exactly once", async () => {
    const ep = await createEndpoint();
    // Same created_at for all, so the id tiebreak is what keeps pages apart.
    const at = new Date();
    const ids = new Set<string>();
    for (let i = 0; i < 7; i++) ids.add(await addDelivery(ep.id, "dead", at));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?status=dead&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const body: { data: { id: string }[]; next_cursor: string | null } = (await list(q)).json();
      seen.push(...body.data.map((d) => d.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, 7);
    assert.deepEqual(new Set(seen), ids);
  });

  test("bad query parameters are 400", async () => {
    for (const q of [
      "?status=lost",
      "?limit=0",
      "?limit=101",
      "?endpoint_id=nope",
      `?cursor=${randomUUID()}`,
      "?colour=red",
    ]) {
      assert.equal((await list(q)).statusCode, 400, q);
    }
  });
});

describe("POST /deliveries/:id/replay", () => {
  test("a dead delivery is resent with the same webhook-id and a fresh signature", async () => {
    const ep = await createEndpoint();
    const event = await app.inject({
      method: "POST",
      url: "/events",
      payload: { type: "order.paid", payload: { order_id: 7 } },
    });
    const eventId = event.json().event_id;
    const worker = new DeliveryWorker(
      pool,
      workerConfig({ maxAttempts: 1, leaseMs: 2000, requestTimeoutMs: 1000 }),
      { egressPolicy: localPolicy(receiver.url), log: () => {} }
    );

    // One attempt allowed and the receiver is down: dead-lettered.
    receiver.respond((_req, res) => res.writeHead(500).end());
    await worker.tick();
    const [{ id }] = (await list("?status=dead")).json().data;
    assert.equal((await delivery(id)).status, "dead");

    // Rotate with no overlap: the old secret is gone, so a stored signature
    // could never verify.
    const rotated = await app.inject({
      method: "POST",
      url: `/endpoints/${ep.id}/secrets/rotate`,
      payload: { overlap_hours: 0 },
    });
    const newSecret: string = rotated.json().secret;

    receiver.respond((_req, res) => res.writeHead(200).end("ok"));
    wakes = 0;
    const res = await replayOne(id);
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().status, "pending");
    assert.equal(res.json().attempts, 0);
    assert.equal(wakes, 1, "replay wakes the worker");

    // Due immediately, so one tick sends it, with a full retry budget.
    assert.equal(await worker.tick(), 1);
    await worker.stop();
    const row = await delivery(id);
    assert.equal(row.status, "delivered");
    assert.equal(row.attempts, 1);

    assert.equal(receiver.received.length, 2);
    const [first, replayed] = receiver.received;
    assert.equal(first.headers["webhook-id"], eventId);
    assert.equal(replayed.headers["webhook-id"], eventId);
    // Verifies against the new secret alone, inside the replay window.
    assert.equal(verifyWebhook(replayed.headers, replayed.body, newSecret).id, eventId);
    assert.throws(() => verifyWebhook(replayed.headers, replayed.body, ep.secret));

    // The failed attempt stays in the history next to the replayed one.
    const { rows } = await pool.query(
      `SELECT attempt, outcome FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id`,
      [id]
    );
    assert.deepEqual(
      rows.map((r) => [r.attempt, r.outcome]),
      [
        [1, "dead"],
        [1, "delivered"],
      ]
    );
  });

  test("resets attempts, makes the row due now and clears the claim token", async () => {
    const ep = await createEndpoint();
    const id = await addDelivery(ep.id, "dead");
    // A stale token, as if a stalled worker still thought it held the row.
    const staleToken = randomUUID();
    await pool.query(`UPDATE deliveries SET claim_token = $2 WHERE id = $1`, [id, staleToken]);

    assert.equal((await replayOne(id)).statusCode, 202);
    const row = await delivery(id);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.claim_token, null);
    assert.ok(row.next_attempt_at.getTime() <= Date.now());

    // That worker's fenced result write now matches nothing.
    const stale = await pool.query(
      `UPDATE deliveries SET status = 'dead' WHERE id = $1 AND claim_token = $2 AND status = 'pending'`,
      [id, staleToken]
    );
    assert.equal(stale.rowCount, 0);
  });

  test("only dead deliveries can be replayed", async () => {
    const ep = await createEndpoint();
    for (const status of ["pending", "delivered"] as const) {
      const id = await addDelivery(ep.id, status);
      const before = await delivery(id);
      const res = await replayOne(id);
      assert.equal(res.statusCode, 409, status);
      assert.match(res.json().error, new RegExp(`delivery is ${status}`));
      assert.deepEqual(await delivery(id), before);
    }
    assert.equal(wakes, 0);
  });

  test("unknown or malformed ids are 404", async () => {
    assert.equal((await replayOne(randomUUID())).statusCode, 404);
    assert.equal((await replayOne("not-a-uuid")).statusCode, 404);
  });

  test("a delivery to an inactive endpoint is not replayed", async () => {
    const ep = await createEndpoint();
    const id = await addDelivery(ep.id, "dead");
    await pool.query(`UPDATE endpoints SET active = false WHERE id = $1`, [ep.id]);
    const res = await replayOne(id);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "endpoint is inactive");
    assert.equal((await delivery(id)).status, "dead");
  });

  test("concurrent replays of one delivery: exactly one wins", async () => {
    const ep = await createEndpoint();
    const id = await addDelivery(ep.id, "dead");
    const results = await Promise.all(Array.from({ length: 20 }, () => replayOne(id)));
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [202, ...Array(19).fill(409)]);
    assert.equal(wakes, 1);
  });
});

describe("POST /endpoints/:id/replay", () => {
  test("replays every dead delivery of that endpoint and nothing else", async () => {
    const ep = await createEndpoint();
    const other = await createEndpoint();
    for (let i = 0; i < 3; i++) await addDelivery(ep.id, "dead");
    await addDelivery(ep.id, "delivered");
    await addDelivery(ep.id, "pending");
    await addDelivery(other.id, "dead");

    const res = await replayAll(ep.id);
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(res.json(), { replayed: 3 });
    assert.equal(wakes, 1);
    assert.deepEqual(await statuses(ep.id), { pending: 4, delivered: 1 });
    assert.deepEqual(await statuses(other.id), { dead: 1 });

    const { rows } = await pool.query(
      `SELECT attempts, claim_token FROM deliveries
       WHERE endpoint_id = $1 AND status = 'pending' AND next_attempt_at <= now()`,
      [ep.id]
    );
    assert.equal(rows.length, 3, "replayed rows are due now; the old pending row is not");
    assert.ok(rows.every((r) => r.attempts === 0 && r.claim_token === null));

    // Nothing dead left: a second call replays nothing and doesn't wake.
    wakes = 0;
    assert.deepEqual((await replayAll(ep.id)).json(), { replayed: 0 });
    assert.equal(wakes, 0);
  });

  test("since limits the replay to deliveries created at or after it", async () => {
    const ep = await createEndpoint();
    const cutoff = new Date(Date.now() - 3_600_000);
    const old = await addDelivery(ep.id, "dead", new Date(cutoff.getTime() - 1000));
    const recent = await addDelivery(ep.id, "dead", cutoff);

    const res = await replayAll(ep.id, { since: cutoff.toISOString() });
    assert.deepEqual(res.json(), { replayed: 1 });
    assert.equal((await delivery(recent)).status, "pending");
    assert.equal((await delivery(old)).status, "dead");
  });

  test("errors: unknown endpoint 404, inactive 409, bad body 400", async () => {
    assert.equal((await replayAll(randomUUID())).statusCode, 404);
    assert.equal((await replayAll("not-a-uuid")).statusCode, 404);

    const ep = await createEndpoint();
    const id = await addDelivery(ep.id, "dead");
    assert.equal((await replayAll(ep.id, { since: "yesterday" })).statusCode, 400);
    assert.equal((await replayAll(ep.id, { until: new Date().toISOString() })).statusCode, 400);

    await pool.query(`UPDATE endpoints SET active = false WHERE id = $1`, [ep.id]);
    assert.equal((await replayAll(ep.id)).statusCode, 409);
    assert.equal((await delivery(id)).status, "dead");
  });

  test("concurrent bulk and single replays: each dead row is replayed exactly once", async () => {
    const ep = await createEndpoint();
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await addDelivery(ep.id, "dead"));

    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => replayAll(ep.id)),
      ...ids.slice(0, 20).map((id) => replayOne(id)),
    ]);
    // A deadlock or any other error would surface here as a 500.
    const bulk = results.slice(0, 8);
    const single = results.slice(8);
    assert.ok(bulk.every((r) => r.statusCode === 202), bulk.map((r) => r.body).join());
    assert.ok(single.every((r) => r.statusCode === 202 || r.statusCode === 409));

    const replayed =
      bulk.reduce((n, r) => n + r.json().replayed, 0) +
      single.filter((r) => r.statusCode === 202).length;
    assert.equal(replayed, 200);
    assert.deepEqual(await statuses(ep.id), { pending: 200 });
  });
});
