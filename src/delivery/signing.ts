import { createHmac } from "node:crypto";

// Standard Webhooks signature: base64(HMAC-SHA256(key, "id.timestamp.body")),
// where key is the base64-decoded part of "whsec_...". One "v1,<sig>" entry
// per active secret, space separated, so receivers keep verifying while a
// secret is being rotated. https://www.standardwebhooks.com/
export function signatureHeader(
  secrets: string[],
  msgId: string,
  timestampSec: number,
  body: string
): string {
  const signedContent = `${msgId}.${timestampSec}.${body}`;
  return secrets
    .map((secret) => {
      const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      const sig = createHmac("sha256", key).update(signedContent).digest("base64");
      return `v1,${sig}`;
    })
    .join(" ");
}
