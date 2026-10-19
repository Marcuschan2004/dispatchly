import { pool } from "./db.js";
import { buildApp } from "./app.js";
import { authDisabledFromEnv } from "./auth/api-keys.js";
import { DeliveryWorker, workerConfigFromEnv } from "./delivery/worker.js";

// RUN_WORKER=true runs the delivery worker in this process (one free-tier
// service instead of two). Ingest then wakes it the moment deliveries exist,
// so it can sleep through idle periods without polling.
const worker =
  process.env.RUN_WORKER === "true"
    ? new DeliveryWorker(pool, workerConfigFromEnv())
    : null;

const authDisabled = authDisabledFromEnv();
const app = await buildApp({
  pool,
  authDisabled,
  logger: true,
  onDeliveriesCreated: () => worker?.wake(),
});
if (authDisabled) app.log.warn("AUTH_DISABLED=true: the API accepts requests without a key");

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
worker?.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await worker?.stop();
    await pool.end();
  });
}
