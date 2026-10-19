import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";

const CreateEvent = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()),
});

export async function eventRoutes(
  app: FastifyInstance,
  opts: { pool: pg.Pool; onDeliveriesCreated?: () => void }
) {
  const { pool } = opts;
  app.post("/events", async (req, reply) => {
    const parsed = CreateEvent.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { type, payload } = parsed.data;
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ?? null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ON CONFLICT DO NOTHING avoids the check-then-insert race: two
      // concurrent requests with the same key both attempt the INSERT; exactly
      // one wins, the other silently inserts nothing and falls through to the
      // lookup below.
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO events (type, payload, idempotency_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [type, payload, idempotencyKey]
      );

      if (inserted.length === 0) {
        // Duplicate key: the event already exists. A retry of the same
        // request gets the original event id. The same key with a different
        // body is a client bug (say, a key reused across orders); returning
        // the old id would silently drop the new event, so refuse it, as
        // Stripe does. jsonb equality ignores key order and whitespace, so
        // only a real difference in content counts.
        const { rows: existing } = await client.query<{ id: string; same: boolean }>(
          `SELECT id, (type = $2 AND payload = $3::jsonb) AS same
           FROM events WHERE idempotency_key = $1`,
          [idempotencyKey, type, payload]
        );
        await client.query("COMMIT");
        if (!existing[0].same) {
          return reply.code(422).send({
            error:
              "Idempotency-Key was already used with a different request body; " +
              "use a new key for a new event",
          });
        }
        return reply.code(200).send({ event_id: existing[0].id });
      }

      const eventId = inserted[0].id;

      // Single INSERT…SELECT fans out to every active endpoint whose
      // subscription matches: empty event_types means "all types".
      const { rows: deliveries } = await client.query<{ id: string }>(
        `INSERT INTO deliveries (event_id, endpoint_id)
         SELECT $1, id
         FROM endpoints
         WHERE active = TRUE
           AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))
         RETURNING id`,
        [eventId, type]
      );

      await client.query("COMMIT");
      if (deliveries.length > 0) opts.onDeliveriesCreated?.();
      return reply.code(201).send({
        event_id: eventId,
        deliveries_created: deliveries.length,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
