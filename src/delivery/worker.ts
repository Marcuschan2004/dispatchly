import type pg from "pg";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { fetch, type Dispatcher, type Response } from "undici";
import {
  checkUrl,
  createGuardedAgent,
  egressPolicyFromEnv,
  type EgressPolicy,
  type Resolver,
} from "../security/ssrf.js";
import { MAX_LIVE_SECRETS } from "../security/secrets.js";
import { backoffDelayMs, parseRetryAfterMs } from "./backoff.js";
import { signatureHeader } from "../security/signing.js";

const ConfigSchema = z
  .object({
    concurrency: z.coerce.number().int().positive().default(10),
    leaseMs: z.coerce.number().int().positive().default(60_000),
    requestTimeoutMs: z.coerce.number().int().positive().default(10_000),
    maxAttempts: z.coerce.number().int().positive().default(15),
    backoffBaseMs: z.coerce.number().int().positive().default(30_000),
    backoffCapMs: z.coerce.number().int().positive().default(3_600_000),
    // Longest the worker sleeps with nothing due. Each wake-up is a query, so
    // on a scale-to-zero database this must stay above its idle timeout
    // (5 min on Neon) or the database never sleeps.
    maxIdleMs: z.coerce.number().int().positive().default(600_000),
  })
  // The lease must outlast the request, or a slow but healthy request gets
  // claimed by a second worker while the first is still waiting on it.
  .refine((c) => c.leaseMs >= 2 * c.requestTimeoutMs, {
    message: "leaseMs must be at least 2x requestTimeoutMs",
  });

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function workerConfig(
  overrides: Partial<Record<keyof WorkerConfig, unknown>> = {}
): WorkerConfig {
  return ConfigSchema.parse(overrides);
}

export function workerConfigFromEnv(env = process.env): WorkerConfig {
  return workerConfig({
    concurrency: env.WORKER_CONCURRENCY,
    leaseMs: env.WORKER_LEASE_MS,
    requestTimeoutMs: env.WORKER_REQUEST_TIMEOUT_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    backoffBaseMs: env.WORKER_BACKOFF_BASE_MS,
    backoffCapMs: env.WORKER_BACKOFF_CAP_MS,
    maxIdleMs: env.WORKER_MAX_IDLE_MS,
  });
}

type Logger = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>
) => void;

const jsonLogger: Logger = (level, msg, fields) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }));

interface Job {
  id: string;
  claim_token: string;
  attempt: number;
  event_id: string;
  event_type: string;
  payload: unknown;
  event_created_at: Date;
  url: string;
  secrets: string[];
}

interface SendResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  snippet: string | null;
  retryAfterMs: number | null;
  durationMs: number;
}

const SNIPPET_BYTES = 1024;

export class DeliveryWorker {
  readonly id: string;
  private readonly egressPolicy: EgressPolicy;
  private readonly dispatcher: Dispatcher;
  private readonly log: Logger;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private woken = false;
  private interruptSleep: (() => void) | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: WorkerConfig,
    opts: {
      id?: string;
      egressPolicy?: EgressPolicy;
      // Tests inject DNS answers to simulate rebinding.
      resolve?: Resolver;
      log?: Logger;
    } = {}
  ) {
    this.id = opts.id ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.egressPolicy = opts.egressPolicy ?? egressPolicyFromEnv();
    this.dispatcher = createGuardedAgent(this.egressPolicy, { resolve: opts.resolve });
    this.log = opts.log ?? jsonLogger;
  }

  start(): void {
    this.loop ??= this.run();
  }

  // Stops claiming and waits for in-flight attempts to finish. Anything a
  // hard kill abandons instead is recovered when its lease expires.
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.loop;
    await this.dispatcher.close();
  }

  // In-process signal from ingest: new deliveries exist, stop sleeping.
  wake(): void {
    this.woken = true;
    this.interruptSleep?.();
  }

  // One pass: dead-letter crashed final attempts, claim a batch, deliver it.
  // Returns how many deliveries were attempted.
  async tick(): Promise<number> {
    await this.reapExhausted();
    const jobs = await this.claim(this.config.concurrency);
    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  private async run(): Promise<void> {
    this.log("info", "worker started", { worker_id: this.id });
    while (!this.stopping) {
      this.woken = false;
      try {
        if ((await this.tick()) > 0) continue;
        // Sleep until the next retry or lease expiry instead of polling, so
        // an idle database can scale to zero. wake() cuts the sleep short.
        await this.sleep(await this.msUntilNextDue());
      } catch (err) {
        this.log("error", "worker loop error", { error: String(err) });
        await this.sleep(Math.min(5_000, this.config.maxIdleMs));
      }
    }
    this.log("info", "worker stopped", { worker_id: this.id });
  }

  private sleep(ms: number): Promise<void> {
    if (this.woken || this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.interruptSleep = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.interruptSleep = done;
    });
  }

  private async msUntilNextDue(): Promise<number> {
    const { rows } = await this.pool.query<{ ms: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (min(next_attempt_at) - now())) * 1000 AS ms
       FROM deliveries WHERE status = 'pending'`
    );
    const ms = rows[0].ms === null ? this.config.maxIdleMs : Number(rows[0].ms);
    // Floor of 25 ms: a due row another worker is mid-claim on is skipped by
    // SKIP LOCKED, and this keeps us from spinning until it commits.
    return Math.min(this.config.maxIdleMs, Math.max(25, Math.ceil(ms)));
  }

  // Claim up to `limit` due deliveries in one autocommit statement. The row
  // locks from SKIP LOCKED last only for this statement; after it, the lease
  // (next_attempt_at pushed forward) is what keeps other workers away.
  // Claiming increments attempts, so a payload that crashes the worker every
  // time still reaches dead instead of looping forever.
  private async claim(limit: number): Promise<Job[]> {
    const { rows } = await this.pool.query<Job>(
      `WITH due AS (
         SELECT id FROM deliveries
         WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < $4
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE deliveries d
         SET attempts        = d.attempts + 1,
             next_attempt_at = now() + $2::int * interval '1 millisecond',
             claim_token     = gen_random_uuid(),
             updated_at      = now()
         FROM due WHERE d.id = due.id
         RETURNING d.id, d.event_id, d.endpoint_id, d.attempts, d.claim_token
       ), expired AS (
         -- An unfinished attempt on a row we just claimed belonged to a
         -- worker whose lease ran out.
         UPDATE delivery_attempts a SET outcome = 'lease_expired'
         FROM claimed c
         WHERE a.delivery_id = c.id AND a.outcome IS NULL
       ), started AS (
         INSERT INTO delivery_attempts (delivery_id, claim_token, attempt, worker_id)
         SELECT id, claim_token, attempts, $3 FROM claimed
       )
       SELECT c.id, c.claim_token, c.attempts AS attempt,
              e.id AS event_id, e.type AS event_type, e.payload,
              e.created_at AS event_created_at, ep.url,
              ARRAY(SELECT s.secret FROM endpoint_secrets s
                    WHERE s.endpoint_id = ep.id
                      AND (s.expires_at IS NULL OR s.expires_at > now())
                    ORDER BY s.created_at DESC
                    LIMIT ${MAX_LIVE_SECRETS}) AS secrets
       FROM claimed c
       JOIN events e ON e.id = c.event_id
       JOIN endpoints ep ON ep.id = c.endpoint_id`,
      [limit, this.config.leaseMs, this.id, this.config.maxAttempts]
    );
    return rows;
  }

  // A worker that dies during the final allowed attempt leaves a pending row
  // that claim() will never pick up again (attempts < max fails). Once its
  // lease runs out, it goes dead.
  private async reapExhausted(): Promise<void> {
    await this.pool.query(
      `WITH dead AS (
         UPDATE deliveries
         SET status = 'dead', claim_token = NULL, updated_at = now(),
             last_error = 'retries exhausted: attempt ' || attempts
                          || ' did not finish before its lease expired'
         WHERE status = 'pending' AND next_attempt_at <= now() AND attempts >= $1
         RETURNING id
       )
       UPDATE delivery_attempts a SET outcome = 'lease_expired'
       FROM dead WHERE a.delivery_id = dead.id AND a.outcome IS NULL`,
      [this.config.maxAttempts]
    );
  }

  // Never throws: every failure becomes a recorded attempt or a log line.
  private async process(job: Job): Promise<void> {
    const result = await this.send(job);

    let status: "delivered" | "pending" | "dead";
    let outcome: "delivered" | "retry" | "dead";
    let delayMs: number | null = null;
    if (result.ok) {
      status = outcome = "delivered";
    } else if (job.attempt >= this.config.maxAttempts) {
      status = outcome = "dead";
    } else {
      status = "pending";
      outcome = "retry";
      const { backoffBaseMs, backoffCapMs } = this.config;
      const jittered = backoffDelayMs(job.attempt, backoffBaseMs, backoffCapMs);
      delayMs = Math.min(backoffCapMs, Math.max(jittered, result.retryAfterMs ?? 0));
    }

    try {
      // Fenced on claim_token: if our lease expired and another worker
      // re-claimed the row, the token has changed and this write matches
      // nothing. The attempt row is still filled in, marked lease_expired.
      const { rows } = await this.pool.query<{ owned: boolean }>(
        `WITH d AS (
           UPDATE deliveries
           SET status           = $3,
               next_attempt_at  = CASE WHEN $4::int IS NULL THEN next_attempt_at
                                       ELSE now() + $4::int * interval '1 millisecond' END,
               claim_token      = NULL,
               last_status_code = $5,
               last_error       = $6,
               updated_at       = now()
           WHERE id = $1 AND claim_token = $2 AND status = 'pending'
           RETURNING id
         )
         UPDATE delivery_attempts
         SET finished_at = now(), duration_ms = $7, status_code = $5, error = $6,
             response_snippet = $8,
             outcome = CASE WHEN EXISTS (SELECT 1 FROM d) THEN $9 ELSE 'lease_expired' END
         WHERE claim_token = $2
         RETURNING EXISTS (SELECT 1 FROM d) AS owned`,
        [
          job.id,
          job.claim_token,
          status,
          delayMs,
          result.statusCode,
          result.error,
          result.durationMs,
          result.snippet,
          outcome,
        ]
      );
      if (!rows[0]?.owned) {
        this.log("warn", "lease lost before result was recorded; another worker owns this delivery", {
          delivery_id: job.id,
          attempt: job.attempt,
        });
      }
    } catch (err) {
      // The row keeps its lease and becomes due again when it expires, so a
      // failed write here costs a duplicate send, never a lost event.
      this.log("error", "failed to record attempt result", {
        delivery_id: job.id,
        error: String(err),
      });
    }
  }

  private async send(job: Job): Promise<SendResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      // The URL host is re-checked on every attempt because an IP literal
      // never reaches the guarded lookup, and the URL may predate the guard.
      const url = new URL(job.url);
      checkUrl(url, this.egressPolicy);
      if (job.secrets.length === 0) throw new Error("endpoint has no active signing secret");

      const body = JSON.stringify({
        type: job.event_type,
        timestamp: job.event_created_at.toISOString(),
        data: job.payload,
      });
      // Signed per attempt with a fresh timestamp and the current secrets, so
      // retries and replays pass the receiver's replay window and rotation.
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Dispatchly/0.1",
          // The event id, the same on every attempt: receivers dedupe on it.
          "webhook-id": job.event_id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signatureHeader(job.secrets, job.event_id, timestamp, body),
        },
        body,
        // Never follow redirects: a 3xx could bounce us to an internal
        // address after the destination check passed.
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        dispatcher: this.dispatcher,
      });
      const snippet = await readSnippet(res);
      const ok = res.status >= 200 && res.status < 300;
      const retryable = res.status === 429 || res.status === 503;
      return {
        ok,
        statusCode: res.status,
        error: ok
          ? null
          : res.status >= 300 && res.status < 400
            ? `HTTP ${res.status} (redirects are not followed)`
            : `HTTP ${res.status}`,
        snippet,
        retryAfterMs: retryable ? parseRetryAfterMs(res.headers.get("retry-after")) : null,
        durationMs: elapsed(),
      };
    } catch (err) {
      return {
        ok: false,
        statusCode: null,
        error: describeError(err, this.config.requestTimeoutMs),
        snippet: null,
        retryAfterMs: null,
        durationMs: elapsed(),
      };
    }
  }
}

async function readSnippet(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A body that errors or times out doesn't change the status we got.
  } finally {
    reader.cancel().catch(() => {});
  }
  const text = cleanText(Buffer.concat(chunks).subarray(0, SNIPPET_BYTES).toString("utf8"));
  return text || null;
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `timeout after ${timeoutMs}ms`;
    // fetch wraps network errors as TypeError("fetch failed") with the cause.
    const cause = err.cause as { code?: string; message?: string } | undefined;
    const detail = cause?.code ?? cause?.message;
    return cleanText(detail ? `${err.message}: ${detail}` : err.message).slice(0, 500);
  }
  return cleanText(String(err)).slice(0, 500);
}

// Postgres TEXT can't hold NUL bytes, and receivers control these strings.
function cleanText(s: string): string {
  return s.replaceAll("\u0000", "");
}
