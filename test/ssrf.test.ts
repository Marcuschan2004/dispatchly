import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { DeliveryWorker, workerConfig } from "../src/delivery/worker.js";
import {
  DEFAULT_POLICY,
  checkUrl,
  egressPolicyFromEnv,
  isBlockedIp,
  validateEndpointUrl,
  type EgressPolicy,
  type Resolver,
} from "../src/security/ssrf.js";
import {
  createDelivery,
  createTestDatabase,
  localPolicy,
  resetTables,
  startReceiver,
} from "./helpers.js";

const PUBLIC = "93.184.215.14";
const answer =
  (...ips: string[]): Resolver =>
  async () =>
    ips.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("IP classifier", () => {
  // prettier-ignore
  const blockedIps = [
    "0.0.0.0", "0.255.255.255",
    "10.0.0.1", "10.255.255.255",
    "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.1.2.3",
    "169.254.169.254", "169.254.0.1",
    "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9",
    "224.0.0.1", "239.255.255.250",
    "240.0.0.1", "255.255.255.255",
    "::", "::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2002:7f00:1::1", // 6to4 wrapping 127.0.0.1
    "fc00::1", "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "not-an-ip", "",
  ];
  // prettier-ignore
  const publicIps = [
    "8.8.8.8", "1.1.1.1", PUBLIC,
    "172.15.255.255", "172.32.0.0", // just outside 172.16/12
    "100.63.255.255", "100.128.0.0", // just outside 100.64/10
    "2606:4700::1111", "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ];

  for (const ip of blockedIps) {
    test(`blocks ${ip || "(empty)"}`, () => assert.equal(isBlockedIp(ip), true));
  }
  for (const ip of publicIps) {
    test(`allows ${ip}`, () => assert.equal(isBlockedIp(ip), false));
  }
});

describe("URL checks", () => {
  const rejected: [string, RegExp][] = [
    ["file:///etc/passwd", /scheme file:/],
    ["gopher://127.0.0.1:6379/_x", /scheme gopher:/],
    ["ftp://example.com/", /scheme ftp:/],
    ["http://example.com/", /scheme http: is not allowed; use https/],
    ["https://127.0.0.1/", /127\.0\.0\.1 is in a blocked range/],
    ["https://2130706433/", /127\.0\.0\.1/], // decimal form of 127.0.0.1
    ["https://0x7f.1/", /127\.0\.0\.1/], // hex shorthand
    ["https://017700000001/", /127\.0\.0\.1/], // octal
    ["https://[::1]/", /::1 is in a blocked range/],
    ["https://[::ffff:127.0.0.1]/", /blocked range/],
    ["https://169.254.169.254/latest/meta-data/", /169\.254\.169\.254/],
    ["https://0.0.0.0/", /0\.0\.0\.0/],
    ["https://user:pw@example.com/", /credentials/],
    ["https://token@example.com/", /credentials/],
    ["https://example.com:6379/", /port 6379/],
    ["https://example.com:22/", /port 22/],
    ["not a url", /not a valid URL/],
  ];
  for (const [url, message] of rejected) {
    test(`registration rejects ${url}`, async () => {
      await assert.rejects(validateEndpointUrl(url, DEFAULT_POLICY, answer(PUBLIC)), message);
    });
  }

  test("accepts a public https URL", async () => {
    const url = await validateEndpointUrl(
      "https://example.com/hook",
      DEFAULT_POLICY,
      answer(PUBLIC)
    );
    assert.equal(url.href, "https://example.com/hook");
  });

  test("rejects a name that resolves to a blocked address", async () => {
    await assert.rejects(
      validateEndpointUrl("https://internal.example.com/", DEFAULT_POLICY, answer("10.0.0.5")),
      /internal\.example\.com resolves to 10\.0\.0\.5/
    );
  });

  test("rejects a name if ANY of its addresses is blocked", async () => {
    await assert.rejects(
      validateEndpointUrl(
        "https://mixed.example.com/",
        DEFAULT_POLICY,
        answer(PUBLIC, "127.0.0.1")
      ),
      /resolves to 127\.0\.0\.1/
    );
  });

  test("real DNS: localhost is rejected", async () => {
    await assert.rejects(
      validateEndpointUrl("https://localhost/", DEFAULT_POLICY),
      /localhost resolves to/
    );
  });

  test("accepts a name that doesn't resolve yet; delivery checks it again", async () => {
    const failing: Resolver = async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    await validateEndpointUrl("https://not-yet.example.com/", DEFAULT_POLICY, failing);
  });

  test("http and extra ports only when the policy allows them", () => {
    const dev: EgressPolicy = { ...DEFAULT_POLICY, allowHttp: true, allowedPorts: [443, 80, 8080] };
    checkUrl(new URL("http://example.com:8080/"), dev);
    assert.throws(
      () => checkUrl(new URL("http://example.com:8080/"), DEFAULT_POLICY),
      /scheme http:/
    );
  });

  test("egressPolicyFromEnv parses and validates its settings", () => {
    assert.deepEqual(egressPolicyFromEnv({}), DEFAULT_POLICY);
    assert.deepEqual(
      egressPolicyFromEnv({
        ENDPOINT_ALLOW_HTTP: "true",
        ENDPOINT_ALLOW_PORTS: "4000, 8080",
        ENDPOINT_ALLOW_IPS: "127.0.0.1",
      }),
      { allowHttp: true, allowedPorts: [443, 80, 4000, 8080], allowedIps: ["127.0.0.1"] }
    );
    assert.throws(
      () => egressPolicyFromEnv({ ENDPOINT_ALLOW_PORTS: "http" }),
      /ENDPOINT_ALLOW_PORTS/
    );
    assert.throws(
      () => egressPolicyFromEnv({ ENDPOINT_ALLOW_IPS: "localhost" }),
      /ENDPOINT_ALLOW_IPS/
    );
  });
});

describe("POST /endpoints", () => {
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    pool = await createTestDatabase();
    app = await buildApp({
      pool,
      authDisabled: true,
      egressPolicy: DEFAULT_POLICY,
      resolve: answer(PUBLIC),
    });
  });
  after(async () => {
    await app.close();
    await pool.end();
  });

  test("400 for blocked URLs, and nothing is stored", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "https://10.1.2.3/",
    ]) {
      const res = await app.inject({ method: "POST", url: "/endpoints", payload: { url } });
      assert.equal(res.statusCode, 400, url);
      assert.ok(res.json().error.url, url);
    }
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM endpoints");
    assert.equal(rows[0].n, 0);
  });

  test("201 for a public https URL, stored in normalized form", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/endpoints",
      payload: { url: "HTTPS://Example.COM:443/hook" },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().url, "https://example.com/hook");
  });
});

// The receiver listens on 127.0.0.1. Every test here except the control
// uses a policy that does NOT allow 127.0.0.1, so a request reaching the
// receiver means the guard failed.
describe("delivery-time guard", () => {
  let pool: pg.Pool;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let port: string;
  let strict: EgressPolicy;

  before(async () => {
    pool = await createTestDatabase();
    receiver = await startReceiver();
    port = new URL(receiver.url).port;
    strict = { ...localPolicy(receiver.url), allowedIps: [] };
  });
  after(async () => {
    await receiver.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetTables(pool);
    receiver.received.length = 0;
  });

  async function deliverOnce(url: string, policy: EgressPolicy, resolve?: Resolver) {
    const { deliveryId } = await createDelivery(pool, url);
    const worker = new DeliveryWorker(pool, workerConfig({ maxAttempts: 3 }), {
      egressPolicy: policy,
      resolve,
      log: () => {},
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    const { rows } = await pool.query("SELECT * FROM deliveries WHERE id = $1", [deliveryId]);
    return rows[0];
  }

  test("control: an allowed address is delivered through the guarded lookup", async () => {
    const d = await deliverOnce(
      `http://receiver.test:${port}/hook`,
      localPolicy(receiver.url),
      answer("127.0.0.1")
    );
    assert.equal(d.status, "delivered");
    assert.equal(receiver.received.length, 1);
  });

  test("DNS rebinding: public at registration, loopback at delivery", async () => {
    let calls = 0;
    const rebinding: Resolver = async () => answer(calls++ === 0 ? PUBLIC : "127.0.0.1")("");
    const url = `http://rebind.test:${port}/hook`;

    // Registration sees the public answer and accepts.
    await validateEndpointUrl(url, strict, rebinding);
    // Delivery resolves again, gets 127.0.0.1, and refuses to connect.
    const d = await deliverOnce(url, strict, rebinding);

    assert.equal(receiver.received.length, 0);
    assert.equal(d.status, "pending");
    assert.match(d.last_error, /destination blocked: rebind\.test resolved to 127\.0\.0\.1/);
  });

  test("a name with one public and one loopback address is blocked", async () => {
    const d = await deliverOnce(
      `http://mixed.test:${port}/hook`,
      strict,
      answer(PUBLIC, "127.0.0.1")
    );
    assert.equal(receiver.received.length, 0);
    assert.match(d.last_error, /resolved to 127\.0\.0\.1/);
  });

  test("real DNS: localhost is blocked at connect time", async () => {
    const d = await deliverOnce(`http://localhost:${port}/hook`, strict);
    assert.equal(receiver.received.length, 0);
    assert.match(d.last_error, /destination blocked: localhost resolved to/);
  });

  // These rows skip registration (inserted straight into the database), as
  // a URL stored before the guard existed would. IP literals never reach
  // the lookup, so only the per-attempt URL check stops them.
  for (const host of ["127.0.0.1", "2130706433", "0x7f.1", "[::ffff:127.0.0.1]"]) {
    test(`IP literal ${host} is blocked before connecting`, async () => {
      const d = await deliverOnce(`http://${host}:${port}/hook`, strict);
      assert.equal(receiver.received.length, 0);
      assert.match(d.last_error, /is in a blocked range/);
    });
  }

  test("a redirect to cloud metadata is recorded as a failure and never followed", async () => {
    receiver.respond((_req, res) =>
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end()
    );
    const d = await deliverOnce(receiver.url, localPolicy(receiver.url));
    assert.equal(receiver.received.length, 1);
    assert.equal(d.status, "pending");
    assert.equal(d.last_status_code, 302);
    assert.equal(d.last_error, "HTTP 302 (redirects are not followed)");
  });
});
