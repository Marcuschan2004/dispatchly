import Fastify from "fastify";
import type pg from "pg";
import { requireApiKey } from "./auth/api-keys.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";

export interface AppOptions {
  pool: pg.Pool;
  authDisabled?: boolean;
  logger?: boolean;
  onDeliveriesCreated?: () => void;
}

// Builds the API without listening, so tests can drive it with app.inject().
export async function buildApp(opts: AppOptions) {
  const { pool } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  if (!opts.authDisabled) requireApiKey(app, { pool, public: ["/health"] });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  await app.register(endpointRoutes, { pool });
  await app.register(eventRoutes, { pool, onDeliveriesCreated: opts.onDeliveriesCreated });
  return app;
}
