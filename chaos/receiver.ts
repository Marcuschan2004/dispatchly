// A deliberately unreliable webhook receiver for the chaos harness.
//
// Each endpoint gets a profile: the chance that a request is answered with a
// 500, left hanging until Dispatchly's timeout, dropped before processing, or
// processed and then dropped before the 200 goes out ("ack lost", the case
// that makes exactly-once impossible over HTTP).
//
// Every request is written to an append-only JSONL log with a synchronous
// write BEFORE the response is sent. That log is the ground truth the
// verifier compares the database against: if the log has no processed line
// for a delivery the database calls delivered, an event was lost.
import http from "node:http";
import { closeSync, openSync, writeSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { verifyWebhook } from "../src/security/signing.js";

export type Behavior = "ok" | "error" | "hang" | "drop" | "ack_lost" | "bad_signature";

export interface Profile {
  error: number;
  hang: number;
  drop: number;
  ackLost: number;
  // Answers take a random 0..latencyMs, like a real handler doing work. It
  // widens the window in which a kill or pause lands mid-request.
  latencyMs: number;
}

export interface Receipt {
  t: number;
  endpoint: string;
  webhook_id: string;
  behavior: Behavior;
}

// "Processed" means the receiver did its work for this request: from the
// receiver's point of view the event arrived, whether or not the 200 did.
export const isProcessed = (r: Receipt) => r.behavior === "ok" || r.behavior === "ack_lost";

// mulberry32: tiny seeded PRNG, so a run's random choices can be replayed
// with the same CHAOS_SEED. Timing still varies between runs.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickBehavior(profile: Profile, random: () => number): Behavior {
  let r = random();
  for (const [behavior, p] of [
    ["error", profile.error],
    ["hang", profile.hang],
    ["drop", profile.drop],
    ["ack_lost", profile.ackLost],
  ] as const) {
    if (r < p) return behavior;
    r -= p;
  }
  return "ok";
}

export async function startFlakyReceiver(opts: {
  logPath: string;
  profiles: Record<string, Profile>;
  random: () => number;
}) {
  const fd = openSync(opts.logPath, "a");
  const secrets = new Map<string, string>();
  const stats: Record<string, Record<Behavior, number>> = {};

  const record = (receipt: Receipt) => {
    writeSync(fd, JSON.stringify(receipt) + "\n");
    const s = (stats[receipt.endpoint] ??= {
      ok: 0, error: 0, hang: 0, drop: 0, ack_lost: 0, bad_signature: 0,
    });
    s[receipt.behavior]++;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const endpoint = /^\/hook\/([\w-]+)$/.exec(req.url ?? "")?.[1] ?? "";
      const profile = opts.profiles[endpoint];
      const secret = secrets.get(endpoint);
      if (!profile || !secret) return void res.writeHead(404).end();

      const webhookId = String(req.headers["webhook-id"] ?? "");
      try {
        verifyWebhook(req.headers, Buffer.concat(chunks), secret);
      } catch {
        // Dispatchly should never send a bad signature; the verifier fails
        // the run if this ever appears in the log.
        record({ t: Date.now(), endpoint, webhook_id: webhookId, behavior: "bad_signature" });
        return void res.writeHead(401).end();
      }

      // The log line is written when the receiver acts, after its simulated
      // work. A request whose worker died before then leaves no record,
      // like a handler that stops when the client disconnects.
      const behavior = pickBehavior(profile, opts.random);
      setTimeout(() => {
        if (req.socket.destroyed) return;
        record({ t: Date.now(), endpoint, webhook_id: webhookId, behavior });
        switch (behavior) {
          case "ok":
            return void res.writeHead(200).end("ok");
          case "error":
            return void res.writeHead(500).end("chaos: error");
          case "hang":
            return; // never answered; the worker's request timeout ends it
          case "drop":
          case "ack_lost":
            return void req.socket.destroy();
        }
      }, opts.random() * profile.latencyMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (endpoint: string) => `http://127.0.0.1:${port}/hook/${endpoint}`,
    setSecret: (endpoint: string, secret: string) => secrets.set(endpoint, secret),
    stats,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closeSync(fd);
    },
  };
}
