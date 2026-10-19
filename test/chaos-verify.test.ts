import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pickBehavior, seededRandom, type Receipt } from "../chaos/receiver.js";
import { verify, type VerifyInput } from "../chaos/verify.js";

// A verifier that has never failed proves nothing, so each test breaks one
// thing and checks the verifier notices.

let t = 0;
const receipt = (webhook_id: string, endpoint: string, behavior: Receipt["behavior"]): Receipt => ({
  t: t++,
  endpoint,
  webhook_id,
  behavior,
});

// Two events, two endpoints, everything delivered once.
function healthy(): VerifyInput {
  return {
    accepted: ["e1", "e2"],
    endpoints: ["a", "b"],
    eventsInDb: ["e1", "e2"],
    deliveries: [
      { event_id: "e1", endpoint: "a", status: "delivered", attempts: 1 },
      { event_id: "e1", endpoint: "b", status: "delivered", attempts: 2 },
      { event_id: "e2", endpoint: "a", status: "delivered", attempts: 1 },
      { event_id: "e2", endpoint: "b", status: "dead", attempts: 6 },
    ],
    receipts: [
      receipt("e1", "a", "ok"),
      receipt("e1", "b", "error"),
      receipt("e1", "b", "ok"),
      receipt("e2", "a", "ok"),
      receipt("e2", "b", "error"),
    ],
    maxAttempts: 6,
    idempotencyMismatches: 0,
  };
}

const kinds = (input: VerifyInput) => verify(input).violations.map((v) => v.kind);

describe("chaos verifier", () => {
  test("passes a run where every delivery is delivered or dead", () => {
    const report = verify(healthy());
    assert.equal(report.pass, true);
    assert.equal(report.expected_deliveries, 4);
    assert.equal(report.delivered, 3);
    assert.equal(report.dead, 1);
    assert.equal(report.missing, 0);
    assert.equal(report.duplicate_receipts, 0);
  });

  test("fails when the database says delivered but the receiver never got it", () => {
    const input = healthy();
    input.receipts = input.receipts.filter((r) => !(r.webhook_id === "e2" && r.endpoint === "a"));
    assert.deepEqual(kinds(input), ["delivered_not_received"]);
    assert.equal(verify(input).missing, 1);
  });

  test("fails when an accepted event never reached the database", () => {
    const input = healthy();
    input.eventsInDb = ["e1"];
    input.deliveries = input.deliveries.filter((d) => d.event_id !== "e2");
    assert.deepEqual(kinds(input), ["event_missing", "delivery_missing", "delivery_missing"]);
  });

  test("fails when fan-out skipped an endpoint", () => {
    const input = healthy();
    input.deliveries = input.deliveries.filter((d) => !(d.event_id === "e1" && d.endpoint === "b"));
    assert.deepEqual(kinds(input), ["delivery_missing"]);
  });

  test("fails on a delivery still pending after the drain", () => {
    const input = healthy();
    input.deliveries[3] = { event_id: "e2", endpoint: "b", status: "pending", attempts: 3 };
    assert.deepEqual(kinds(input), ["stuck_pending"]);
  });

  test("fails on a delivery dead-lettered before using its retries", () => {
    const input = healthy();
    input.deliveries[3].attempts = 2;
    assert.deepEqual(kinds(input), ["dead_before_max_attempts"]);
  });

  test("fails on a bad signature or an idempotency mismatch", () => {
    const input = healthy();
    input.receipts.push(receipt("e1", "a", "bad_signature"));
    input.idempotencyMismatches = 1;
    assert.deepEqual(kinds(input), ["bad_signature", "idempotency_mismatch"]);
  });

  test("counts duplicates without failing, and attributes those after a lost 200", () => {
    const input = healthy();
    // e1/a: processed, 200 lost, processed again. e2/a: a plain repeat.
    input.receipts.splice(0, 1, receipt("e1", "a", "ack_lost"), receipt("e1", "a", "ok"));
    input.receipts.push(receipt("e2", "a", "ok"));
    const report = verify(input);
    assert.equal(report.pass, true);
    assert.equal(report.unique_received, 3);
    assert.equal(report.duplicate_receipts, 2);
    assert.equal(report.duplicates_after_lost_ack, 1);
    assert.equal(report.max_copies, 2);
  });

  test("ack_lost counts as received; drop and hang do not", () => {
    const input = healthy();
    input.receipts = input.receipts.map((r) =>
      r.webhook_id === "e1" && r.endpoint === "a" ? { ...r, behavior: "ack_lost" } : r
    );
    assert.equal(verify(input).pass, true);
    input.receipts = input.receipts.map((r) =>
      r.webhook_id === "e1" && r.endpoint === "a" ? { ...r, behavior: "drop" } : r
    );
    assert.deepEqual(kinds(input), ["delivered_not_received"]);
  });

  test("a dead delivery the receiver processed anyway is reported, not failed", () => {
    const input = healthy();
    input.receipts.push(receipt("e2", "b", "ack_lost"));
    const report = verify(input);
    assert.equal(report.pass, true);
    assert.equal(report.dead_but_received, 1);
  });
});

describe("flaky receiver behavior", () => {
  test("pickBehavior follows the profile's probabilities", () => {
    const random = seededRandom(1);
    const profile = { error: 0.3, hang: 0.1, drop: 0.1, ackLost: 0.1, latencyMs: 0 };
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) {
      const b = pickBehavior(profile, random);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    for (const [behavior, p] of [["error", 0.3], ["hang", 0.1], ["drop", 0.1], ["ack_lost", 0.1], ["ok", 0.4]] as const) {
      assert.ok(Math.abs(counts[behavior] / 20_000 - p) < 0.02, `${behavior}: ${counts[behavior]}`);
    }
  });

  test("seededRandom repeats for the same seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  });
});
