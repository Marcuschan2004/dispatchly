import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type pg from "pg";
import { signatureHeader } from "../src/security/signing.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import {
  SCHEMA,
  createReceiverServer,
  handleWebhook,
  type WebhookEvent,
} from "../examples/receiver.js";
import { createDelivery, createTestDatabase, localPolicy, resetTables } from "./helpers.js";

const SECRET = "whsec_" + Buffer.alloc(32, 1).toString("base64");
const T = Math.floor(Date.now() / 1000);

let pool: pg.Pool;
let handled: WebhookEvent[];
const apply = async (client: pg.PoolClient, event: WebhookEvent) => {
  // Real work inside the receiver's transaction.
  await client.query("SELECT 1");
  handled.push(event);
};

before(async () => {
  pool = await createTestDatabase();
  await pool.query(SCHEMA);
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetTables(pool);
  await pool.query("TRUNCATE processed_webhooks");
  handled = [];
});

function request(id: string, ts = T, body = '{"type":"order.paid","data":{"n":1}}') {
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signatureHeader([SECRET], id, ts, body),
    },
    body,
  };
}

const receive = (r: ReturnType<typeof request>, now = T) =>
  handleWebhook(pool, r.headers, r.body, [SECRET], apply, { now });

describe("example receiver", () => {
  test("processes a genuine webhook once", async () => {
    const out = await receive(request("evt-1"));
    assert.deepEqual(out, { status: 200, result: "processed", id: "evt-1" });
    assert.equal(handled.length, 1);
    assert.equal(handled[0].type, "order.paid");
  });

  test("the same request twice inside the window: processed once, both get 200", async () => {
    const r = request("evt-2");
    assert.equal((await receive(r, T)).result, "processed");
    const second = await receive(r, T + 10);
    assert.deepEqual(second, { status: 200, result: "duplicate", id: "evt-2" });
    assert.equal(handled.length, 1);
  });

  test("a captured request replayed after the window is rejected", async () => {
    const r = request("evt-3");
    const out = await receive(r, T + 6 * 60);
    assert.deepEqual(out, { status: 401, result: "rejected", reason: "timestamp_out_of_window" });
    assert.equal(handled.length, 0);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM processed_webhooks");
    assert.equal(rows[0].n, 0, "rejected requests leave no trace");
  });

  test("a sender retry (fresh timestamp, same id) is deduplicated", async () => {
    await receive(request("evt-4", T));
    const retry = await receive(request("evt-4", T + 3600), T + 3600);
    assert.equal(retry.result, "duplicate");
    assert.equal(handled.length, 1);
  });

  test("forged requests are rejected", async () => {
    const r = request("evt-5");
    const out = await receive({ ...r, body: r.body.replace("1", "9") });
    assert.equal(out.status, 401);
    assert.equal(handled.length, 0);
  });

  test("if processing fails the id isn't recorded, so the retry is processed", async () => {
    const failing = async () => {
      throw new Error("downstream down");
    };
    const r = request("evt-6");
    const first = await handleWebhook(pool, r.headers, r.body, [SECRET], failing, { now: T });
    assert.equal(first.status, 500);
    const retry = await receive(request("evt-6", T + 60), T + 60);
    assert.equal(retry.result, "processed");
    assert.equal(handled.length, 1);
  });

  test("10 copies at once are processed exactly once", async () => {
    const r = request("evt-7");
    const outs = await Promise.all(Array.from({ length: 10 }, () => receive(r)));
    assert.equal(outs.filter((o) => o.result === "processed").length, 1);
    assert.equal(outs.filter((o) => o.result === "duplicate").length, 9);
    assert.equal(handled.length, 1);
  });
});

describe("end to end", () => {
  let server: http.Server;
  let url: string;
  let captured: { headers: http.IncomingHttpHeaders; body: string } | null = null;

  before(async () => {
    server = createReceiverServer(pool, [SECRET], apply, () => {});
    // Capture the raw request on its way in, as an attacker on the network could.
    server.prependListener("request", (req: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured ??= { headers: req.headers, body: Buffer.concat(chunks).toString() };
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("Dispatchly delivers, the receiver verifies, a later replay of the capture fails", async () => {
    const { deliveryId, secret } = await createDelivery(pool, url);
    await pool.query("UPDATE endpoint_secrets SET secret = $1 WHERE secret = $2", [SECRET, secret]);

    const worker = new DeliveryWorker(pool, workerConfig({}), {
      egressPolicy: localPolicy(url),
      log: () => {},
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    const { rows } = await pool.query("SELECT status FROM deliveries WHERE id = $1", [deliveryId]);
    assert.equal(rows[0].status, "delivered");
    assert.equal(handled.length, 1);
    assert.ok(captured);

    // Replay the captured bytes 6 minutes later.
    const out = await handleWebhook(pool, captured.headers, captured.body, [SECRET], apply, {
      now: Math.floor(Date.now() / 1000) + 6 * 60,
    });
    assert.deepEqual(out, { status: 401, result: "rejected", reason: "timestamp_out_of_window" });
    // And immediately: inside the window, the id dedupe catches it.
    const now = await handleWebhook(pool, captured.headers, captured.body, [SECRET], apply);
    assert.equal(now.result, "duplicate");
    assert.equal(handled.length, 1);
  });
});
