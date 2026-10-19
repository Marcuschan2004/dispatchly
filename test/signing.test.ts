import { test } from "node:test";
import assert from "node:assert/strict";
import { signatureHeader } from "../src/delivery/signing.js";

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
