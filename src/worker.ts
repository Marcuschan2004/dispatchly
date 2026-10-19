// Standalone worker process. Run several of these against one database to
// scale out, or kill -9 one mid-delivery to watch its lease expire and another
// worker pick the delivery up. In this mode nothing calls wake(), so set
// WORKER_MAX_IDLE_MS low (e.g. 1000) for snappy pickup of new events.
import { pool } from "./db.js";
import { DeliveryWorker, workerConfigFromEnv } from "./delivery/worker.js";
import { retentionConfigFromEnv, startRetention } from "./retention.js";

const worker = new DeliveryWorker(pool, workerConfigFromEnv());
worker.start();
const stopRetention = startRetention(pool, retentionConfigFromEnv());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await worker.stop();
    await stopRetention();
    await pool.end();
  });
}
