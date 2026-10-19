import Fastify from "fastify";
import { pool } from "./db.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

await app.register(endpointRoutes);
await app.register(eventRoutes);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
