import type pg from "pg";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// Prometheus metrics, served at GET /metrics behind the API key.
//
// Two sources, on purpose:
//
// - Queue state (how many deliveries are pending, due, dead, and how late the
//   oldest due one is) is read from Postgres at scrape time. The deliveries
//   table is the queue, so it is the source of truth, and the numbers are
//   right no matter how many worker processes there are or which one crashed.
//
// - Attempt counts and latency are events inside a worker, so the worker
//   records them in memory. They cover only workers in this process
//   (RUN_WORKER=true); a standalone worker process doesn't serve /metrics.

export type AttemptOutcome =
  | "delivered" // 2xx, result recorded
  | "retry" // failed, scheduled for another attempt
  | "dead" // failed on the last attempt, now in the dead-letter queue
  | "lease_lost" // result dropped by the claim_token fence: another worker owns it
  | "record_failed"; // couldn't write the result; the lease expiry retries it

export interface Metrics {
  registry: Registry;
  recordAttempt(outcome: AttemptOutcome, durationMs: number, ok: boolean): void;
}

// Request latency buckets for webhook receivers: most answer in tens of
// milliseconds, and the default request timeout is 10 s.
const LATENCY_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createMetrics(pool: pg.Pool, opts: { defaultMetrics?: boolean } = {}): Metrics {
  // A registry per instance, not the global one, so tests can build many apps.
  const registry = new Registry();
  if (opts.defaultMetrics ?? true) {
    collectDefaultMetrics({ register: registry, prefix: "dispatchly_" });
  }

  const attempts = new Counter({
    name: "dispatchly_delivery_attempts_total",
    help: "Delivery attempts finished by workers in this process, by outcome.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const latency = new Histogram({
    name: "dispatchly_delivery_attempt_duration_seconds",
    help: "Time from sending a webhook to the receiver's answer, timeout or error.",
    labelNames: ["result"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  // Start every series at 0 so rate() works from the first scrape.
  for (const o of ["delivered", "retry", "dead", "lease_lost", "record_failed"] as const) {
    attempts.inc({ outcome: o }, 0);
  }

  // The queue gauges come from one query per scrape. prom-client collects
  // every metric in parallel, so each gauge's collect() awaits the same
  // in-flight query instead of one gauge filling in the others (which would
  // leave the first scrape empty and every later one a scrape behind). If
  // Postgres is down the scrape fails with a 500 rather than reporting zeros.
  let inFlight: Promise<QueueState> | null = null;
  const readQueue = (): Promise<QueueState> => {
    inFlight ??= queryQueueState(pool).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  new Gauge({
    name: "dispatchly_deliveries",
    help: "Deliveries in the database, by status. status=dead is the dead-letter queue.",
    labelNames: ["status"] as const,
    registers: [registry],
    async collect() {
      const q = await readQueue();
      this.set({ status: "pending" }, q.pending);
      this.set({ status: "delivered" }, q.delivered);
      this.set({ status: "dead" }, q.dead);
    },
  });
  new Gauge({
    name: "dispatchly_deliveries_due",
    help: "Pending deliveries whose next attempt time has passed: the backlog.",
    registers: [registry],
    async collect() {
      this.set((await readQueue()).due);
    },
  });
  new Gauge({
    name: "dispatchly_oldest_due_delivery_age_seconds",
    help: "How long the oldest due delivery has been waiting. 0 when nothing is due.",
    registers: [registry],
    async collect() {
      this.set((await readQueue()).oldest_due_s);
    },
  });

  return {
    registry,
    recordAttempt(outcome, durationMs, ok) {
      attempts.inc({ outcome });
      latency.observe({ result: ok ? "success" : "failure" }, durationMs / 1000);
    },
  };
}

interface QueueState {
  pending: number;
  delivered: number;
  dead: number;
  due: number;
  oldest_due_s: number;
}

async function queryQueueState(pool: pg.Pool): Promise<QueueState> {
  const { rows } = await pool.query<QueueState>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int   AS pending,
       count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
       count(*) FILTER (WHERE status = 'dead')::int      AS dead,
       count(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now())::int AS due,
       COALESCE(EXTRACT(EPOCH FROM now() - min(next_attempt_at)
         FILTER (WHERE status = 'pending' AND next_attempt_at <= now())), 0)::float8
         AS oldest_due_s
     FROM deliveries`
  );
  return rows[0];
}
