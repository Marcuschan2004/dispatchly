import Fastify from "fastify";
import { pool } from "./db.js";
import { endpointRoutes } from "./routes/endpoints.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

await app.register(endpointRoutes);
// TODO (you): await app.register(eventRoutes);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
