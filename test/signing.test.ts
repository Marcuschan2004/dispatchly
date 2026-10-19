import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import {
  signatureHeader,
  verifyWebhook,
  WebhookVerificationError,
  type VerificationFailure,
} from "../src/security/signing.js";

test("matches the Standard Webhooks reference test vector", () => {
  // From the standard-webhooks repo's reference implementations.
  const header = signatureHeader(
    ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
    "msg_p5jXN8AQM9LWM0D4loKWxJek",
    1614265330,
    '{"test": 2432232314}'
  );
  assert.equal(header, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("signs with every active secret during rotation", () => {
  const header = signatureHeader(["whsec_YWFh", "whsec_YmJi"], "id", 1, "{}");
  assert.match(header, /^v1,\S+ v1,\S+$/);
});

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const ID = "2f1c6a52-6a5e-4a0e-9a59-6f1f4b3c2d10";
const T = 1_792_440_000;
const BODY = '{"type":"order.paid","timestamp":"2026-10-19T00:00:00.000Z","data":{"n":1}}';

function signed(opts: { secrets?: string[]; id?: string; ts?: number; body?: string } = {}) {
  const id = opts.id ?? ID;
  const ts = opts.ts ?? T;
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signatureHeader(opts.secrets ?? [SECRET], id, ts, opts.body ?? BODY),
  };
}

function failsWith(reason: VerificationFailure, fn: () => unknown) {
  assert.throws(fn, (err) => err instanceof WebhookVerificationError && err.reason === reason);
}

describe("verifyWebhook: signature", () => {
  test("accepts a genuine request", () => {
    assert.deepEqual(verifyWebhook(signed(), BODY, SECRET, { now: T }), { id: ID, timestamp: T });
  });

  test("accepts the raw body as a Buffer", () => {
    verifyWebhook(signed(), Buffer.from(BODY), SECRET, { now: T });
  });

  test("header names are case-insensitive and arrays use the first value", () => {
    const h = signed();
    verifyWebhook(
      {
        "Webhook-Id": h["webhook-id"],
        "WEBHOOK-TIMESTAMP": [h["webhook-timestamp"]],
        "webhook-signature": h["webhook-signature"],
      },
      BODY,
      SECRET,
      { now: T }
    );
  });

  const tampered: [string, () => unknown][] = [
    [
      "one changed body byte",
      () => verifyWebhook(signed(), BODY.replace("1}", "2}"), SECRET, { now: T }),
    ],
    [
      "re-serialized JSON",
      () => verifyWebhook(signed(), JSON.stringify(JSON.parse(BODY), null, 1), SECRET, { now: T }),
    ],
    [
      "a changed webhook-id",
      () => verifyWebhook({ ...signed(), "webhook-id": "other" }, BODY, SECRET, { now: T }),
    ],
    [
      "a changed timestamp",
      () =>
        verifyWebhook({ ...signed(), "webhook-timestamp": String(T + 1) }, BODY, SECRET, {
          now: T,
        }),
    ],
    [
      "a signature from another secret",
      () => verifyWebhook(signed({ secrets: [OTHER] }), BODY, SECRET, { now: T }),
    ],
    [
      "only a v2 entry",
      () =>
        verifyWebhook(
          { ...signed(), "webhook-signature": signed()["webhook-signature"].replace("v1,", "v2,") },
          BODY,
          SECRET,
          { now: T }
        ),
    ],
    [
      "a truncated signature",
      () =>
        verifyWebhook(
          { ...signed(), "webhook-signature": signed()["webhook-signature"].slice(0, 20) },
          BODY,
          SECRET,
          { now: T }
        ),
    ],
    [
      "garbage",
      () => verifyWebhook({ ...signed(), "webhook-signature": "v1,!!!" }, BODY, SECRET, { now: T }),
    ],
  ];
  for (const [name, fn] of tampered) {
    test(`rejects ${name}`, () => failsWith("invalid_signature", fn));
  }

  test("one valid entry among garbage is enough (rotation depends on it)", () => {
    const h = signed();
    h["webhook-signature"] = `v1,AAAA v2,xyz ${h["webhook-signature"]} v1,${"B".repeat(44)}`;
    verifyWebhook(h, BODY, SECRET, { now: T });
  });

  test("a receiver holding old and new secrets accepts either signature", () => {
    verifyWebhook(signed({ secrets: [OTHER] }), BODY, [SECRET, OTHER], { now: T });
    verifyWebhook(signed({ secrets: [SECRET] }), BODY, [SECRET, OTHER], { now: T });
  });

  test("missing headers", () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"] as const) {
      const h: Record<string, string> = signed();
      delete h[name];
      failsWith("missing_headers", () => verifyWebhook(h, BODY, SECRET, { now: T }));
    }
  });

  test("non-numeric timestamp", () => {
    for (const ts of ["abc", "1e9", "-5", "1792440000.5", " 1792440000"]) {
      failsWith("invalid_timestamp", () =>
        verifyWebhook({ ...signed(), "webhook-timestamp": ts }, BODY, SECRET, { now: T })
      );
    }
  });
});

describe("verifyWebhook: replay window", () => {
  const at = (offset: number) => () => verifyWebhook(signed(), BODY, SECRET, { now: T + offset });

  test("inside ±300 s passes", () => {
    for (const offset of [0, 10, 299, 300, -299, -300]) at(offset)();
  });

  test("a replay 301 s later fails", () => failsWith("timestamp_out_of_window", at(301)));
  test("an hour later fails", () => failsWith("timestamp_out_of_window", at(3600)));
  test("a timestamp 301 s in the future fails", () =>
    failsWith("timestamp_out_of_window", at(-301)));

  test("tolerance is configurable", () => {
    verifyWebhook(signed(), BODY, SECRET, { now: T + 500, toleranceSec: 600 });
    failsWith("timestamp_out_of_window", () =>
      verifyWebhook(signed(), BODY, SECRET, { now: T + 61, toleranceSec: 60 })
    );
  });

  test("the signature is checked before the timestamp", () => {
    // A forged, stale request reports the forgery, not the age.
    failsWith("invalid_signature", () =>
      verifyWebhook(signed({ secrets: [OTHER] }), BODY, SECRET, { now: T + 3600 })
    );
  });
});

// The official library is an independent implementation of the same spec.
// Agreeing with it in both directions shows the wire format is right.
describe("cross-check with the standardwebhooks library", () => {
  test("the library verifies Dispatchly's signatures", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = new Webhook(SECRET).verify(BODY, signed({ ts: now }));
    assert.deepEqual(payload, JSON.parse(BODY));
  });

  test("the library verifies when Dispatchly signs with several secrets", () => {
    const now = Math.floor(Date.now() / 1000);
    new Webhook(OTHER).verify(BODY, signed({ ts: now, secrets: [SECRET, OTHER] }));
  });

  test("the library rejects a tampered body, like Dispatchly", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.throws(() => new Webhook(SECRET).verify(BODY + " ", signed({ ts: now })));
  });

  test("Dispatchly verifies the library's signatures", () => {
    const signature = new Webhook(SECRET).sign(ID, new Date(T * 1000), BODY);
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(T),
      "webhook-signature": signature,
    };
    assert.equal(signature, signatureHeader([SECRET], ID, T, BODY));
    verifyWebhook(headers, BODY, SECRET, { now: T });
  });
});
