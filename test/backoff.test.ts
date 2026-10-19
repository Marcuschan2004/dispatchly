import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelayMs, parseRetryAfterMs } from "../src/delivery/backoff.js";

test("backoff ceiling doubles per attempt and stops at the cap", () => {
  const max = () => 0.999999;
  assert.equal(backoffDelayMs(1, 1000, 60_000, max), 999);
  assert.equal(backoffDelayMs(2, 1000, 60_000, max), 1999);
  assert.equal(backoffDelayMs(4, 1000, 60_000, max), 7999);
  assert.equal(backoffDelayMs(10, 1000, 60_000, max), 59_999);
  assert.equal(backoffDelayMs(5000, 1000, 60_000, max), 59_999); // 2**4999 is Infinity
});

test("full jitter can return anything from 0 up to the ceiling", () => {
  assert.equal(backoffDelayMs(3, 1000, 60_000, () => 0), 0);
  for (let i = 0; i < 1000; i++) {
    const d = backoffDelayMs(3, 1000, 60_000);
    assert.ok(d >= 0 && d < 4000, `delay ${d} out of range`);
  }
});

test("Retry-After accepts seconds or an HTTP date", () => {
  assert.equal(parseRetryAfterMs("120"), 120_000);
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(parseRetryAfterMs("Mon, 19 Oct 2026 12:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfterMs("Mon, 19 Oct 2026 11:00:00 GMT", now), 0);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("soon"), null);
});
