import Fastify from "fastify";
import { pool } from "./db.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";
import { DeliveryWorker, workerConfigFromEnv } from "./delivery/worker.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

await app.register(endpointRoutes);
// RUN_WORKER=true runs the delivery worker in this process (one free-tier
// service instead of two). Ingest then wakes it the moment deliveries exist,
// so it can sleep through idle periods without polling.
const worker =
  process.env.RUN_WORKER === "true"
    ? new DeliveryWorker(pool, workerConfigFromEnv())
    : null;

await app.register(eventRoutes, { onDeliveriesCreated: () => worker?.wake() });

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
