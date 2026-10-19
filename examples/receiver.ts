// An example webhook receiver: what a Dispatchly customer would run.
//
//   WEBHOOK_SECRET=whsec_... npm run receiver     # listens on :4000
//
// It shows the two halves of replay protection working together:
// 1. verifyWebhook() rejects forged requests and anything outside the
//    ±5 minute window, so a request captured today is useless tomorrow.
// 2. A processed_webhooks table with webhook-id as its primary key rejects
//    the same id a second time, which covers a replay inside the window and
//    turns Dispatchly's at-least-once delivery into processed-once.
import http from "node:http";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { verifyWebhook, WebhookVerificationError } from "../src/security/signing.js";

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS processed_webhooks (
    id            TEXT PRIMARY KEY,         -- webhook-id
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

export interface WebhookEvent {
  id: string;
  type: string;
  timestamp: string;
  data: unknown;
}

export type Outcome =
  | { status: 200; result: "processed" | "duplicate"; id: string }
  | { status: 401; result: "rejected"; reason: string }
  | { status: 500; result: "failed"; id: string };

// `apply` does the receiver's real work (mark the order paid, send the
// email). It runs in the same transaction as the id insert, so either both
// commit or neither does. If apply fails, the id isn't recorded, the 500
// makes Dispatchly retry, and the retry gets processed.
export async function handleWebhook(
  pool: pg.Pool,
  headers: http.IncomingHttpHeaders,
  body: Buffer | string,
  secrets: string[],
  apply: (client: pg.PoolClient, event: WebhookEvent) => Promise<void>,
  opts: { now?: number } = {}
): Promise<Outcome> {
  let id: string;
  try {
    id = verifyWebhook(headers, body, secrets, { now: opts.now }).id;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return { status: 401, result: "rejected", reason: err.reason };
    }
    throw err;
  }

  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // ON CONFLICT DO NOTHING: two copies arriving at once both try the
    // insert, exactly one gets a row back. The other waits on the first's
    // uncommitted row, then sees the conflict.
    const { rowCount } = await client.query(
      `INSERT INTO processed_webhooks (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [id]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      // 200, not an error: the sender should stop retrying.
      return { status: 200, result: "duplicate", id };
    }
    const parsed = JSON.parse(body.toString()) as Omit<WebhookEvent, "id">;
    await apply(client, { id, ...parsed });
    await client.query("COMMIT");
    return { status: 200, result: "processed", id };
  } catch {
    await client.query("ROLLBACK").catch((e: Error) => (broken = e));
    return { status: 500, result: "failed", id };
  } finally {
    client.release(broken);
  }
}

// Replay protection only needs ids from the last 5 minutes (older requests
// fail the timestamp check). Keeping them for 7 days also dedupes
// Dispatchly's retries, which can arrive days apart with fresh timestamps.
export async function pruneProcessed(pool: pg.Pool, keepDays = 7): Promise<void> {
  await pool.query(
    `DELETE FROM processed_webhooks WHERE processed_at < now() - $1::int * interval '1 day'`,
    [keepDays]
  );
}

export function createReceiverServer(
  pool: pg.Pool,
  secrets: string[],
  apply: (client: pg.PoolClient, event: WebhookEvent) => Promise<void>,
  log: (line: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l))
): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const outcome = await handleWebhook(pool, req.headers, body, secrets, apply).catch(
        () => ({ status: 500, result: "failed" }) as const
      );
      log({ ...outcome, webhook_id: req.headers["webhook-id"] });
      if (outcome.result === "processed") {
        // For the replay demo: the exact request, ready to send again.
        log({ replay_with: curlCommand(req, body) });
      }
      res.writeHead(outcome.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: outcome.result }));
    });
  });
}

function curlCommand(req: http.IncomingMessage, body: Buffer): string {
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const headers = ["content-type", "webhook-id", "webhook-timestamp", "webhook-signature"]
    .map((h) => `-H ${q(`${h}: ${req.headers[h]}`)}`)
    .join(" ");
  return `curl -s -i -X POST http://${req.headers.host}${req.url} ${headers} --data-binary ${q(body.toString())}`;
}

async function main() {
  const secrets = (process.env.WEBHOOK_SECRET ?? "").split(",").filter(Boolean);
  if (secrets.length === 0) {
    console.error("Set WEBHOOK_SECRET (comma-separate several during a rotation).");
    process.exit(2);
  }
  const pool = new pg.Pool({
    connectionString:
      process.env.RECEIVER_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://dispatchly:dispatchly@localhost:5433/dispatchly",
  });
  await pool.query(SCHEMA);
  await pruneProcessed(pool);
  setInterval(() => pruneProcessed(pool).catch(() => {}), 3600_000).unref();

  const server = createReceiverServer(pool, secrets, async (_client, event) => {
    console.log(JSON.stringify({ handled: event.type, data: event.data }));
  });
  const port = Number(process.env.RECEIVER_PORT ?? 4000);
  server.listen(port, "127.0.0.1", () => console.log(`receiver listening on :${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
