import Fastify from "fastify";
import type pg from "pg";
import { requireApiKey } from "./auth/api-keys.js";
import { deliveryRoutes } from "./routes/deliveries.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";
import { secretCipherFromEnv, type SecretCipher } from "./security/encryption.js";
import { egressPolicyFromEnv, type EgressPolicy, type Resolver } from "./security/ssrf.js";

export interface AppOptions {
  pool: pg.Pool;
  authDisabled?: boolean;
  logger?: boolean;
  // Called when deliveries become due now: new events and replays. The
  // server wires it to worker.wake() so the worker stops sleeping.
  onDeliveriesCreated?: () => void;
  egressPolicy?: EgressPolicy;
  resolve?: Resolver;
  cipher?: SecretCipher;
}

// Builds the API without listening, so tests can drive it with app.inject().
export async function buildApp(opts: AppOptions) {
  const { pool } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  if (!opts.authDisabled) requireApiKey(app, { pool, public: ["/health", "/livez"] });

  // Liveness for keep-warm pings. It must not touch Postgres: a pinger
  // hitting /health every few minutes would keep Neon from ever scaling to
  // zero. (It is also public, so the API key lookup never runs either.)
  app.get("/livez", async () => ({ ok: true }));

  // Readiness: the process is up and can reach the database.
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  await app.register(endpointRoutes, {
    pool,
    cipher: opts.cipher ?? secretCipherFromEnv(),
    egressPolicy: opts.egressPolicy ?? egressPolicyFromEnv(),
    resolve: opts.resolve,
  });
  await app.register(eventRoutes, { pool, onDeliveriesCreated: opts.onDeliveriesCreated });
  await app.register(deliveryRoutes, { pool, onDeliveriesDue: opts.onDeliveriesCreated });
  return app;
}
