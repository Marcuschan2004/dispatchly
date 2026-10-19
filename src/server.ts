import { pool } from "./db.js";
import { buildApp } from "./app.js";
import { authDisabledFromEnv } from "./auth/api-keys.js";
import { DeliveryWorker, workerConfigFromEnv } from "./delivery/worker.js";
import { retentionConfigFromEnv, startRetention } from "./retention.js";
import { checkSecretsReadable, secretCipherFromEnv } from "./security/encryption.js";

// Refuses to start without a valid key (outside loopback dev) or with a key
// that can't read the stored secrets.
const cipher = secretCipherFromEnv();
await checkSecretsReadable(pool, cipher);

// RUN_WORKER=true runs the delivery worker in this process (one free-tier
// service instead of two). Ingest then wakes it the moment deliveries exist,
// so it can sleep through idle periods without polling.
const worker =
  process.env.RUN_WORKER === "true"
    ? new DeliveryWorker(pool, workerConfigFromEnv(), { cipher })
    : null;
// Parsed before listening, so a bad RETENTION_DAYS fails the boot.
const retention = worker ? retentionConfigFromEnv() : null;

const authDisabled = authDisabledFromEnv();
const app = await buildApp({
  pool,
  authDisabled,
  logger: true,
  cipher,
  onDeliveriesCreated: () => worker?.wake(),
});
if (authDisabled) app.log.warn("AUTH_DISABLED=true: the API accepts requests without a key");
if (cipher.isDevKey) {
  app.log.warn("SECRETS_ENCRYPTION_KEY unset: signing secrets use the public dev key");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
worker?.start();
// Background jobs run wherever the worker runs.
const stopRetention = retention ? startRetention(pool, retention) : null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await worker?.stop();
    await stopRetention?.();
    await pool.end();
  });
}
