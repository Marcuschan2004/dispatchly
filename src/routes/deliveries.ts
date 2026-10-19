import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";

const ListDeliveries = z
  .object({
    status: z.enum(["pending", "delivered", "dead"]).optional(),
    endpoint_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    // The id of the last delivery on the previous page.
    cursor: z.string().uuid().optional(),
  })
  .strict();

const BulkReplay = z
  .object({
    // Only deliveries created at or after this time. Omit to replay every
    // dead delivery of the endpoint.
    since: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const Id = z.object({ id: z.string().uuid() });

// What replay does to a dead row: back in the queue, due now, with a full
// retry budget. claim_token is cleared so a worker that stalled through the
// row's last lease can't record a result over the replay (its write is
// fenced on the old token). The event id, and so the webhook-id the receiver
// dedupes on, is untouched. The worker signs every attempt when it sends,
// so the replay carries a fresh timestamp and the endpoint's current secrets.
const REQUEUE = `
  status          = 'pending',
  attempts        = 0,
  next_attempt_at = now(),
  claim_token     = NULL,
  updated_at      = now()`;

const DELIVERY_COLUMNS = `
  d.id, d.event_id, e.type AS event_type, d.endpoint_id, d.status, d.attempts,
  d.next_attempt_at, d.last_status_code, d.last_error, d.created_at, d.updated_at`;

export async function deliveryRoutes(
  app: FastifyInstance,
  opts: { pool: pg.Pool; onDeliveriesDue?: () => void }
) {
  const { pool } = opts;

  // List deliveries, newest first. ?status=dead is the dead-letter queue.
  // Keyset pagination on (created_at, id): stable while rows are added, and
  // no OFFSET scan through rows already seen.
  app.get("/deliveries", async (req, reply) => {
    const parsed = ListDeliveries.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { status, endpoint_id, limit, cursor } = parsed.data;

    if (cursor) {
      const { rowCount } = await pool.query(`SELECT 1 FROM deliveries WHERE id = $1`, [cursor]);
      if (rowCount === 0) return reply.code(400).send({ error: { cursor: "unknown cursor" } });
    }
    const { rows } = await pool.query(
      `SELECT ${DELIVERY_COLUMNS}
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       WHERE ($1::text IS NULL OR d.status = $1)
         AND ($2::uuid IS NULL OR d.endpoint_id = $2)
         AND ($3::uuid IS NULL OR (d.created_at, d.id) <
              (SELECT created_at, id FROM deliveries WHERE id = $3))
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $4`,
      [status ?? null, endpoint_id ?? null, cursor ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    return {
      data: page,
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  });

  // Replay one dead delivery. Only a dead row matches the UPDATE, and
  // Postgres re-checks that condition after waiting on a row lock, so of
  // two concurrent replays exactly one wins and the other gets 409. A
  // delivery that is pending or delivered is never sent again by replay.
  app.post("/deliveries/:id/replay", async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "delivery not found" });

    const { rows } = await pool.query(
      `WITH d AS (
         UPDATE deliveries d SET ${REQUEUE}
         FROM endpoints ep
         WHERE d.id = $1 AND d.status = 'dead'
           AND ep.id = d.endpoint_id AND ep.active
         RETURNING d.*
       )
       SELECT ${DELIVERY_COLUMNS} FROM d JOIN events e ON e.id = d.event_id`,
      [params.data.id]
    );
    if (rows.length === 1) {
      opts.onDeliveriesDue?.();
      return reply.code(202).send(rows[0]);
    }

    // Nothing replayed: say why.
    const { rows: found } = await pool.query<{ status: string; active: boolean }>(
      `SELECT d.status, ep.active
       FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE d.id = $1`,
      [params.data.id]
    );
    if (found.length === 0) return reply.code(404).send({ error: "delivery not found" });
    if (found[0].status !== "dead") {
      return reply.code(409).send({
        error: `delivery is ${found[0].status}; only dead deliveries can be replayed`,
      });
    }
    return reply.code(409).send({ error: "endpoint is inactive" });
  });

  // Replay every dead delivery of one endpoint, e.g. after its receiver was
  // down for a weekend. The rows go back into the normal queue, so the
  // worker's batch size and backoff pace the resend; no extra rate limit.
  app.post("/endpoints/:id/replay", async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "endpoint not found" });
    const body = BulkReplay.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const { rows: endpoint } = await pool.query<{ active: boolean }>(
      `SELECT active FROM endpoints WHERE id = $1`,
      [params.data.id]
    );
    if (endpoint.length === 0) return reply.code(404).send({ error: "endpoint not found" });
    if (!endpoint[0].active) return reply.code(409).send({ error: "endpoint is inactive" });

    // Rows are locked in id order before they are updated. A plain UPDATE
    // locks in whatever order its scan returns rows, which two concurrent
    // statements usually share but Postgres doesn't promise (a different
    // plan, or a synchronized seq scan starting mid-table). With a fixed
    // order, two bulk replays queue on the same first row instead of each
    // holding a row the other needs: no deadlock. A row a concurrent replay
    // already requeued is no longer dead when the lock is granted, so it is
    // skipped: every dead row is replayed exactly once across all callers.
    const { rowCount } = await pool.query(
      `WITH target AS (
         SELECT id FROM deliveries
         WHERE endpoint_id = $1 AND status = 'dead'
           AND ($2::timestamptz IS NULL OR created_at >= $2)
         ORDER BY id
         FOR UPDATE
       )
       UPDATE deliveries d SET ${REQUEUE}
       FROM target WHERE d.id = target.id`,
      [params.data.id, body.data.since ?? null]
    );
    const replayed = rowCount ?? 0;
    if (replayed > 0) opts.onDeliveriesDue?.();
    return reply.code(202).send({ replayed });
  });
}
