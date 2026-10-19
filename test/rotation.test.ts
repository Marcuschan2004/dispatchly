import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import { signatureHeader } from "../src/delivery/signing.js";
import { createTestDatabase, localPolicy, resetTables, startReceiver } from "./helpers.js";

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

async function createEndpoint(): Promise<{ id: string; secret: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/endpoints",
    payload: { url: receiver.url },
  });
  assert.equal(res.statusCode, 201);
  return res.json();
}

const rotate = (id: string, payload?: object) =>
  app.inject({ method: "POST", url: `/endpoints/${id}/secrets/rotate`, payload });

async function rotateOk(id: string, payload?: object): Promise<string> {
  const res = await rotate(id, payload);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().secret;
}

// Sends one event to every endpoint and returns the request the receiver got.
async function deliver() {
  const before = receiver.received.length;
  const ev = await app.inject({
    method: "POST",
    url: "/events",
    payload: { type: "order.paid", payload: { n: 1 } },
  });
  assert.equal(ev.statusCode, 201);
  const worker = new DeliveryWorker(pool, workerConfig({}), {
    egressPolicy: localPolicy(receiver.url),
    log: () => {},
  });
  try {
    await worker.tick();
  } finally {
    await worker.stop();
  }
  assert.equal(receiver.received.length, before + 1);
  return receiver.received[before];
}

// A receiver that only knows `secret` accepts the request if one of the
// header's signatures was made with it.
function acceptedBy(secret: string, req: { headers: Record<string, unknown>; body: string }) {
  const id = req.headers["webhook-id"] as string;
  const ts = Number(req.headers["webhook-timestamp"]);
  const expected = signatureHeader([secret], id, ts, req.body);
  return (req.headers["webhook-signature"] as string).split(" ").includes(expected);
}

async function liveSecrets(endpointId: string) {
  const res = await app.inject({ method: "GET", url: `/endpoints/${endpointId}/secrets` });
  assert.equal(res.statusCode, 200);
  return res.json() as { id: string; created_at: string; expires_at: string | null }[];
}

describe("secret rotation", () => {
  test("during the overlap both the old and the new secret verify", async () => {
    const { id, secret: oldSecret } = await createEndpoint();
    const res = await rotate(id);
    assert.equal(res.statusCode, 201);
    const { secret: newSecret, previous_secrets } = res.json();
    assert.match(newSecret, /^whsec_/);
    assert.notEqual(newSecret, oldSecret);

    // Default overlap is 24 h.
    const expires = new Date(previous_secrets[0].expires_at).getTime();
    assert.ok(Math.abs(expires - (Date.now() + 24 * 3600_000)) < 60_000);

    const req = await deliver();
    const sigs = (req.headers["webhook-signature"] as string).split(" ");
    assert.equal(sigs.length, 2);
    assert.ok(acceptedBy(oldSecret, req), "receiver still on the old secret");
    assert.ok(acceptedBy(newSecret, req), "receiver already on the new secret");
    // Newest first.
    assert.equal(
      sigs[0],
      signatureHeader(
        [newSecret],
        req.headers["webhook-id"] as string,
        Number(req.headers["webhook-timestamp"]),
        req.body
      )
    );
  });

  test("after the overlap ends only the new secret verifies", async () => {
    const { id, secret: oldSecret } = await createEndpoint();
    const newSecret = await rotateOk(id, { overlap_hours: 1 });
    await pool.query(
      `UPDATE endpoint_secrets SET expires_at = now() - interval '1 second'
       WHERE endpoint_id = $1 AND expires_at IS NOT NULL`,
      [id]
    );

    const req = await deliver();
    assert.equal((req.headers["webhook-signature"] as string).split(" ").length, 1);
    assert.ok(acceptedBy(newSecret, req));
    assert.ok(!acceptedBy(oldSecret, req));
  });

  test("overlap_hours: 0 revokes every older secret on the next delivery", async () => {
    const { id, secret: first } = await createEndpoint();
    const second = await rotateOk(id, { overlap_hours: 24 });
    const third = await rotateOk(id, { overlap_hours: 0 });

    const req = await deliver();
    assert.ok(acceptedBy(third, req));
    assert.ok(!acceptedBy(second, req));
    assert.ok(!acceptedBy(first, req));
    assert.equal((await liveSecrets(id)).length, 1);
  });

  test("a later, shorter rotation never extends an older secret", async () => {
    const { id } = await createEndpoint();
    await rotateOk(id, { overlap_hours: 1 });
    await rotateOk(id, { overlap_hours: 72 });
    const live = await liveSecrets(id);
    assert.equal(live.length, 3);
    const [, middle, oldest] = live;
    const hoursLeft = (s: { expires_at: string | null }) =>
      (new Date(s.expires_at!).getTime() - Date.now()) / 3600_000;
    assert.ok(hoursLeft(oldest) <= 1, "oldest keeps its 1 h expiry");
    assert.ok(Math.abs(hoursLeft(middle) - 72) < 0.1);
  });

  test("at most 3 live secrets; overlap 0 still works at the cap", async () => {
    const { id } = await createEndpoint();
    await rotateOk(id);
    await rotateOk(id);
    const res = await rotate(id);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /3 live secrets/);
    assert.equal((await liveSecrets(id)).length, 3);

    await rotateOk(id, { overlap_hours: 0 });
    assert.equal((await liveSecrets(id)).length, 1);
  });

  test("expired secrets are deleted on the next rotation", async () => {
    const { id } = await createEndpoint();
    await rotateOk(id, { overlap_hours: 0 });
    await rotateOk(id, { overlap_hours: 0 });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM endpoint_secrets WHERE endpoint_id = $1",
      [id]
    );
    // The current secret, plus the one the last rotation just expired.
    assert.equal(rows[0].n, 2);
  });

  test("10 concurrent rotations leave exactly one current secret", async () => {
    const { id } = await createEndpoint();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rotate(id, { overlap_hours: 0 }))
    );
    assert.deepEqual(
      results.map((r) => r.statusCode),
      Array(10).fill(201)
    );
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE expires_at IS NULL)::int AS current,
              count(*) FILTER (WHERE expires_at IS NULL OR expires_at > now())::int AS live
       FROM endpoint_secrets WHERE endpoint_id = $1`,
      [id]
    );
    assert.deepEqual(rows[0], { current: 1, live: 1 });
  });

  test("10 concurrent rotations with overlap respect the cap", async () => {
    const { id } = await createEndpoint();
    const codes = (await Promise.all(Array.from({ length: 10 }, () => rotate(id)))).map(
      (r) => r.statusCode
    );
    assert.equal(codes.filter((c) => c === 201).length, 2);
    assert.equal(codes.filter((c) => c === 409).length, 8);
    const live = await liveSecrets(id);
    assert.equal(live.length, 3);
    assert.equal(live.filter((s) => s.expires_at === null).length, 1);
  });

  test("the database refuses a second current secret", async () => {
    const { id } = await createEndpoint();
    await assert.rejects(
      pool.query("INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, 'whsec_x')", [id]),
      /endpoint_secrets_one_current_idx/
    );
  });

  test("validation: unknown endpoint, bad id, bad overlap", async () => {
    const { id } = await createEndpoint();
    assert.equal((await rotate("00000000-0000-0000-0000-000000000000")).statusCode, 404);
    assert.equal((await rotate("not-a-uuid")).statusCode, 404);
    assert.equal((await rotate(id, { overlap_hours: 73 })).statusCode, 400);
    assert.equal((await rotate(id, { overlap_hours: -1 })).statusCode, 400);
    assert.equal((await rotate(id, { overlap_hours: 1.5 })).statusCode, 400);
    assert.equal((await rotate(id, { overlap: 1 })).statusCode, 400);
    assert.equal(
      (await app.inject({ method: "GET", url: "/endpoints/not-a-uuid/secrets" })).statusCode,
      404
    );
  });

  test("secrets only appear in the create and rotate responses", async () => {
    const { id } = await createEndpoint();
    await rotateOk(id);
    for (const url of ["/endpoints", `/endpoints/${id}/secrets`]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      assert.ok(!res.body.includes("whsec_"), url);
    }
  });
});
