import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SecretCipher } from "../security/encryption.js";
import {
  SsrfError,
  validateEndpointUrl,
  type EgressPolicy,
  type Resolver,
} from "../security/ssrf.js";
import {
  MAX_LIVE_SECRETS,
  MAX_OVERLAP_HOURS,
  newSecret,
  rotateSecret,
} from "../security/secrets.js";

const CreateEndpoint = z.object({
  // z.string().url() alone accepts file:, gopher: and metadata URLs; the
  // real check is validateEndpointUrl() in the handler.
  url: z.string().max(2048),
  event_types: z.array(z.string().min(1)).default([]),
});

const RotateSecret = z
  .object({
    overlap_hours: z.number().int().min(0).max(MAX_OVERLAP_HOURS).default(24),
  })
  .strict();

const EndpointId = z.object({ id: z.string().uuid() });

export async function endpointRoutes(
  app: FastifyInstance,
  opts: { pool: pg.Pool; cipher: SecretCipher; egressPolicy: EgressPolicy; resolve?: Resolver }
) {
  const { pool } = opts;
  // Register a new endpoint. The secret is returned ONCE, at creation.
  app.post("/endpoints", async (req, reply) => {
    const parsed = CreateEndpoint.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { event_types } = parsed.data;
    let url: string;
    try {
      url = (await validateEndpointUrl(parsed.data.url, opts.egressPolicy, opts.resolve)).href;
    } catch (err) {
      if (err instanceof SsrfError) return reply.code(400).send({ error: { url: err.message } });
      throw err;
    }
    const secret = newSecret();
    // The id is made here, not by the database, because the ciphertext is
    // bound to it (see SecretCipher.encrypt).
    const id = randomUUID();
    const { encrypted, keyVersion } = opts.cipher.encrypt(secret, id);

    // One statement, so the endpoint and its secret are created atomically:
    // either both rows exist or neither does.
    const { rows } = await pool.query(
      `WITH e AS (
         INSERT INTO endpoints (id, url, event_types)
         VALUES ($1, $2, $3)
         RETURNING id, url, event_types, active, created_at
       ), s AS (
         INSERT INTO endpoint_secrets (endpoint_id, secret_encrypted, secret_key_version)
         SELECT id, $4, $5 FROM e
       )
       SELECT * FROM e`,
      [id, url, event_types, encrypted, keyVersion]
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

  // Start a rotation. Returns the new secret once. Until the old secrets
  // expire, every delivery carries one signature per live secret.
  app.post("/endpoints/:id/secrets/rotate", async (req, reply) => {
    const params = EndpointId.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "endpoint not found" });
    const body = RotateSecret.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const result = await rotateSecret(pool, opts.cipher, params.data.id, body.data.overlap_hours);
    switch (result.kind) {
      case "not_found":
        return reply.code(404).send({ error: "endpoint not found" });
      case "too_many_live":
        return reply.code(409).send({
          error:
            `endpoint already has ${result.live} live secrets (max ${MAX_LIVE_SECRETS}); ` +
            "wait for one to expire, or rotate with overlap_hours: 0 to revoke the old ones now",
        });
      case "rotated":
        return reply.code(201).send({
          id: result.id,
          secret: result.secret,
          created_at: result.created_at,
          previous_secrets: result.previous,
        });
    }
  });

  // Secret metadata only: which secrets are live and when they expire.
  app.get("/endpoints/:id/secrets", async (req, reply) => {
    const params = EndpointId.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "endpoint not found" });
    const { rows } = await pool.query(
      `SELECT s.id, s.created_at, s.expires_at
       FROM endpoints e
       LEFT JOIN endpoint_secrets s
         ON s.endpoint_id = e.id AND (s.expires_at IS NULL OR s.expires_at > now())
       WHERE e.id = $1
       ORDER BY s.created_at DESC`,
      [params.data.id]
    );
    if (rows.length === 0) return reply.code(404).send({ error: "endpoint not found" });
    return rows.filter((r) => r.id !== null);
  });
}
