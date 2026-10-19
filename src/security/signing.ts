import { createHmac, timingSafeEqual } from "node:crypto";

// Standard Webhooks v1 (https://www.standardwebhooks.com/):
//   signature = base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<body>"))
// where key is the base64-decoded part of "whsec_...". The id and timestamp
// are inside the signed content, so an attacker can't paste fresh headers
// onto an old body.

function hmac(secret: string, msgId: string, timestampSec: number | string, body: string | Buffer) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${msgId}.${timestampSec}.`).update(body).digest();
}

// One "v1,<sig>" entry per active secret, space separated, so receivers keep
// verifying while a secret is being rotated.
export function signatureHeader(
  secrets: string[],
  msgId: string,
  timestampSec: number,
  body: string
): string {
  return secrets
    .map((secret) => `v1,${hmac(secret, msgId, timestampSec, body).toString("base64")}`)
    .join(" ");
}

// Five minutes, both directions: what the Standard Webhooks reference
// library uses. Long enough for clock skew and slow networks, short enough
// that a captured request is useless soon after.
export const DEFAULT_TOLERANCE_SEC = 300;

export type VerificationFailure =
  | "missing_headers"
  | "invalid_timestamp"
  | "invalid_signature"
  | "timestamp_out_of_window";

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
  constructor(
    readonly reason: VerificationFailure,
    message: string
  ) {
    super(message);
  }
}

export interface VerifyOptions {
  // Current time in Unix seconds. Injectable so tests need no real waiting.
  now?: number;
  toleranceSec?: number;
}

type Headers = Record<string, string | string[] | undefined>;

// Receiver-side check. Pass the raw body bytes exactly as received: parsing
// and re-serializing JSON can reorder keys or change whitespace, and then no
// signature matches. `secrets` can hold several (old and new during a
// rotation); a match with any of them is enough.
//
// This proves the request is authentic and recent. It does NOT stop the
// same request being delivered twice inside the window, or a legitimate
// retry: the receiver dedupes on the returned id for that (see
// examples/receiver.ts).
export function verifyWebhook(
  headers: Headers,
  body: string | Buffer,
  secrets: string | string[],
  opts: VerifyOptions = {}
): { id: string; timestamp: number } {
  const get = (name: string) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    const value = key === undefined ? undefined : headers[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const id = get("webhook-id");
  const timestampHeader = get("webhook-timestamp");
  const signatures = get("webhook-signature");
  if (!id || !timestampHeader || !signatures) {
    throw new WebhookVerificationError("missing_headers", "missing webhook-* headers");
  }
  if (!/^\d{1,12}$/.test(timestampHeader)) {
    throw new WebhookVerificationError("invalid_timestamp", "webhook-timestamp is not a number");
  }

  // Signature first: until the HMAC checks out, the timestamp is just text
  // the sender chose.
  const candidates = signatures
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => Buffer.from(entry.slice(3), "base64"));
  const matched = [secrets].flat().some((secret) => {
    const expected = hmac(secret, id, timestampHeader, body);
    // timingSafeEqual takes the same time whatever the contents, so the
    // response time doesn't reveal how many leading bytes of a forged
    // signature were right. It needs equal lengths; length isn't secret.
    return candidates.some(
      (sig) => sig.length === expected.length && timingSafeEqual(sig, expected)
    );
  });
  if (!matched) {
    throw new WebhookVerificationError("invalid_signature", "no signature matches");
  }

  // Both directions: a timestamp far in the future would otherwise stay
  // valid for as long as the attacker liked.
  const timestamp = Number(timestampHeader);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      "timestamp_out_of_window",
      `webhook-timestamp is ${now - timestamp}s from now (allowed: ±${tolerance}s)`
    );
  }
  return { id, timestamp };
}
