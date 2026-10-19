import type pg from "pg";
import { z } from "zod";

// Deletes old events once every delivery for them has succeeded, so the
// database stays under Neon's free 0.5 GB. Deleting an event cascades to its
// deliveries and their attempt log. Anything not yet delivered (pending or
// dead) keeps its event and full history until it is delivered or replayed.
//
// The idempotency key goes with the event, so a key can be reused once its
// event has been pruned. Stripe expires keys after 24 hours for the same
// reason.

const ConfigSchema = z.object({
  // 0 turns pruning off.
  days: z.coerce.number().int().nonnegative().default(7),
  intervalMs: z.coerce.number().int().positive().default(6 * 3_600_000),
  batchSize: z.coerce.number().int().positive().default(1_000),
});

export type RetentionConfig = z.infer<typeof ConfigSchema>;

export function retentionConfig(
  overrides: Partial<Record<keyof RetentionConfig, unknown>> = {}
): RetentionConfig {
  return ConfigSchema.parse(overrides);
}

export function retentionConfigFromEnv(env = process.env): RetentionConfig {
  return retentionConfig({ days: env.RETENTION_DAYS, intervalMs: env.RETENTION_INTERVAL_MS });
}

// Returns how many events were deleted. Works in batches so no single
// statement holds locks on a large number of rows. "delivered" is terminal
// (replay only touches dead rows), so an event that qualifies here cannot
// gain an undelivered delivery while it is being deleted.
export async function pruneDelivered(pool: pg.Pool, config: RetentionConfig): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM events WHERE id IN (
         SELECT e.id FROM events e
         WHERE e.created_at < now() - make_interval(days => $1)
           AND NOT EXISTS (
             SELECT 1 FROM deliveries d
             WHERE d.event_id = e.id AND d.status <> 'delivered'
           )
         LIMIT $2
       )`,
      [config.days, config.batchSize]
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < config.batchSize) return total;
  }
}

// Prunes now and then every intervalMs. Returns a function that stops the
// timer and waits for a run in progress.
export function startRetention(pool: pg.Pool, config: RetentionConfig): () => Promise<void> {
  if (config.days === 0) return async () => {};
  const log = (level: string, msg: string, fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }));

  let running: Promise<void> | null = null;
  const run = () => {
    running ??= pruneDelivered(pool, config)
      .then((deleted) => {
        if (deleted > 0) log("info", "retention pruned delivered events", { deleted, days: config.days });
      })
      .catch((err) => log("error", "retention run failed", { error: String(err) }))
      .finally(() => {
        running = null;
      });
  };
  run();
  const timer = setInterval(run, config.intervalMs);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
