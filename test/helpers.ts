import pg from "pg";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

// Tests get their own database, "<your db>_test", rebuilt from db/schema.sql
// on every run. Uses DATABASE_URL (from .env) to find the server.
export function testDatabaseUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL ?? "postgres://dispatchly:dispatchly@localhost:5433/dispatchly"
  );
  url.pathname = `${url.pathname.slice(1)}_test`;
  return url.toString();
}

export async function createTestDatabase(): Promise<pg.Pool> {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.slice(1);
  if (!/^\w+_test$/.test(name)) throw new Error(`refusing to reset database ${name}`);

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }

  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  return pool;
}

export async function resetTables(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE endpoints, events CASCADE");
}

export async function createDelivery(
  pool: pg.Pool,
  url: string,
  payload: Record<string, unknown> = { n: 1 }
): Promise<{ deliveryId: string; eventId: string; secret: string }> {
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const { rows } = await pool.query<{ delivery_id: string; event_id: string }>(
    `WITH ep AS (
       INSERT INTO endpoints (url) VALUES ($1) RETURNING id
     ), s AS (
       INSERT INTO endpoint_secrets (endpoint_id, secret) SELECT id, $2 FROM ep
     ), ev AS (
       INSERT INTO events (type, payload) VALUES ('order.paid', $3) RETURNING id
     )
     INSERT INTO deliveries (event_id, endpoint_id)
     SELECT ev.id, ep.id FROM ev, ep
     RETURNING id AS delivery_id, event_id`,
    [url, secret, payload]
  );
  return { deliveryId: rows[0].delivery_id, eventId: rows[0].event_id, secret };
}

export interface ReceivedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Handler = (
  req: ReceivedRequest,
  res: http.ServerResponse,
  index: number
) => void;

// A webhook receiver whose behavior each test sets. Requests it never answers
// stay open until close().
export async function startReceiver() {
  const received: ReceivedRequest[] = [];
  let handler: Handler = (_req, res) => res.writeHead(200).end("ok");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(r);
      handler(r, res, received.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    respond(h: Handler) {
      handler = h;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
