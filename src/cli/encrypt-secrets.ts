// Encrypts signing secrets stored by versions before encryption at rest.
// Stop the API and workers first: older code reads the plaintext column this
// drops. Safe to run again; it does nothing once the table is migrated.
//
//   npm run encrypt-secrets
import { pool } from "../db.js";
import { encryptPlaintextSecrets, secretCipherFromEnv } from "../security/encryption.js";

try {
  const cipher = secretCipherFromEnv();
  const n = await encryptPlaintextSecrets(pool, cipher);
  if (n === null) {
    console.log("endpoint_secrets is already encrypted; nothing to do.");
  } else {
    console.log(`Encrypted ${n} signing secret(s) with key version ${cipher.keyVersion}.`);
    console.log("Rotate them if a backup or log from before this may have leaked.");
  }
} finally {
  await pool.end();
}
