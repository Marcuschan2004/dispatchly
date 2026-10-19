import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

const CreateEndpoint = z.object({
  url: z.string().url(),
  event_types: z.array(z.string().min(1)).default([]),
});

// Standard Webhooks secret format: "whsec_" + base64 of random bytes.
function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

export async function endpointRoutes(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const { pool } = opts;
  // Register a new endpoint. The secret is returned ONCE, at creation.
  app.post("/endpoints", async (req, reply) => {
    const parsed = CreateEndpoint.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { url, event_types } = parsed.data;
    const secret = newSecret();

    // One statement, so the endpoint and its secret are created atomically:
    // either both rows exist or neither does.
    const { rows } = await pool.query(
      `WITH e AS (
         INSERT INTO endpoints (url, event_types)
         VALUES ($1, $2)
         RETURNING id, url, event_types, active, created_at
       ), s AS (
         INSERT INTO endpoint_secrets (endpoint_id, secret)
         SELECT id, $3 FROM e
       )
       SELECT * FROM e`,
      [url, event_types, secret]
    );
    return reply.code(201).send({ ...rows[0], secret });
  });

  // List endpoints. Never return secrets here.
  app.get("/endpoints", async () => {
    const { rows } = await pool.query(
      `SELECT id, url, event_types, active, created_at
       FROM endpoints ORDER BY created_at DESC`
    );
    return rows;
  });
}
