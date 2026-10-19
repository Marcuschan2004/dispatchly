// Chaos harness: the proof behind "zero lost events".
//
//   npm run chaos
//
// Starts the real API and several real worker processes against a fresh
// "<db>_chaos" database, points three endpoints at a flaky receiver, and
// ingests events through POST /events while it SIGKILLs workers, pauses them
// past their lease, SIGKILLs the API and crash-restarts Postgres. Then it lets
// the queue drain and runs the verifier (chaos/verify.ts).
//
// Writes chaos/out/<run>/summary.md (quotable), results.json and the raw logs.
// Exits 0 on PASS, 1 on FAIL. Tunables are the CHAOS_* variables below.
import { exec, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { migrate } from "../src/migrate.js";
import { seededRandom, startFlakyReceiver, type Profile, type Receipt } from "./receiver.js";
import { verify, type VerifyReport } from "./verify.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const sh = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

const config = {
  events: num("CHAOS_EVENTS", 1000),
  eventsPerSec: num("CHAOS_EVENTS_PER_SEC", 40),
  workers: num("CHAOS_WORKERS", 4),
  seed: num("CHAOS_SEED", Math.floor(Math.random() * 2 ** 31)),
  // Average gap between worker faults (kill one, kill all, or pause one).
  workerFaultEveryMs: num("CHAOS_WORKER_FAULT_EVERY_MS", 1500),
  apiKillEveryMs: num("CHAOS_API_KILL_EVERY_MS", 12_000), // 0 = off
  dbRestartEveryMs: num("CHAOS_DB_RESTART_EVERY_MS", 15_000), // 0 = off
  // Faults keep coming this long after the last event is accepted, so the
  // retry backlog gets hit too, not only fresh deliveries.
  tailMs: num("CHAOS_TAIL_MS", 10_000),
  drainTimeoutMs: num("CHAOS_DRAIN_TIMEOUT_MS", 240_000),
  apiPort: num("CHAOS_API_PORT", 3100),
};

// The "demo / chaos" column of the retry table in docs/reliability-design.md:
// a full retry-to-dead cycle takes seconds instead of hours.
const worker = {
  WORKER_CONCURRENCY: "50",
  WORKER_LEASE_MS: "5000",
  WORKER_REQUEST_TIMEOUT_MS: "2000",
  WORKER_MAX_ATTEMPTS: "6",
  WORKER_BACKOFF_BASE_MS: "1000",
  WORKER_BACKOFF_CAP_MS: "10000",
  // Standalone workers get no wake() from ingest, so they poll this often.
  WORKER_MAX_IDLE_MS: "500",
};
const leaseMs = Number(worker.WORKER_LEASE_MS);
const maxAttempts = Number(worker.WORKER_MAX_ATTEMPTS);

const profiles: Record<string, Profile> = {
  "flaky-a": { error: 0.25, hang: 0.02, drop: 0.05, ackLost: 0.05, latencyMs: 200 },
  "flaky-b": { error: 0.15, hang: 0.02, drop: 0.03, ackLost: 0.1, latencyMs: 200 },
  // Never succeeds: every delivery to it must end dead, none stuck.
  "always-500": { error: 1, hang: 0, drop: 0, ackLost: 0, latencyMs: 0 },
};
const endpointNames = Object.keys(profiles);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `${root}chaos/out/${runId}`;
mkdirSync(outDir, { recursive: true });
const receiptsPath = `${outDir}/receipts.jsonl`;
const logFd = (name: string) => openSync(`${outDir}/${name}.log`, "a");

const say = (msg: string) =>
  console.log(`[chaos ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const chaosRandom = seededRandom(config.seed);
const between = (lo: number, hi: number) => lo + chaosRandom() * (hi - lo);

const counts = {
  worker_kills: 0,
  fleet_kills: 0,
  worker_pauses: 0,
  api_kills: 0,
  db_restarts: 0,
  unexpected_exits: 0,
};
let dbRestartNote = "";

// ---------------------------------------------------------------- database

function chaosDatabaseUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL ?? "postgres://dispatchly:dispatchly@localhost:5433/dispatchly"
  );
  url.pathname = `${url.pathname.slice(1)}_chaos`;
  return url.toString();
}

async function createChaosDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^\w+_chaos$/.test(name)) throw new Error(`refusing to reset database ${name}`);
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
  const db = new pg.Pool({ connectionString: url });
  await migrate(db);
  await db.end();
}

// Restarting Postgres means SIGKILLing it, so on restart it runs crash
// recovery from the WAL: the same thing a power cut or OOM kill would do.
async function dbRestartCommand(): Promise<string | null> {
  const configured = process.env.CHAOS_DB_RESTART_CMD;
  if (configured === "off" || config.dbRestartEveryMs === 0) {
    dbRestartNote = "disabled";
    return null;
  }
  if (configured) return configured;
  try {
    const { stdout } = await sh("docker compose ps -q db", { cwd: root });
    if (stdout.trim()) return "docker compose kill db && docker compose start db";
  } catch {}
  dbRestartNote = "skipped: docker compose db is not running; set CHAOS_DB_RESTART_CMD";
  return null;
}

// ---------------------------------------------------------------- processes

// The children must not inherit the developer's .env worker or SSRF
// settings; the harness sets everything they need explicitly.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(WORKER_|ENDPOINT_ALLOW_|RUN_WORKER$|PORT$|HOST$|AUTH_DISABLED$)/.test(k)
    )
  );
  return { ...env, ...extra };
}

function spawnTs(script: string, env: NodeJS.ProcessEnv, log: number): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", `${root}${script}`], {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
  });
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill("SIGCONT");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await exited(child);
  clearTimeout(timer);
}

// ------------------------------------------------------------------- ingest

const ingest = {
  posted: 0,
  accepted: 0,
  retries: 0,
  // A retry answered 200: the earlier try had committed but its response
  // never arrived. Without Idempotency-Key that would be a duplicate event.
  retry_found_existing: 0,
  gave_up: 0,
  idempotency_checks: 0,
  idempotency_mismatches: 0,
};

async function postEvent(
  apiUrl: string,
  key: string,
  body: string
): Promise<{ status: number; event_id: string } | null> {
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${apiUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 200 || res.status === 201) {
        const { event_id } = (await res.json()) as { event_id: string };
        return { status: res.status, event_id };
      }
      await res.body?.cancel();
    } catch {
      // API down or killed mid-request: same as a 5xx, retry with the same key.
    }
    if (Date.now() > deadline) return null;
    ingest.retries++;
    await sleep(Math.random() * Math.min(2000, 100 * 2 ** attempt));
  }
}

async function ingestAll(apiUrl: string): Promise<string[]> {
  const accepted: string[] = [];
  const intervalMs = 1000 / config.eventsPerSec;
  const start = Date.now();
  const inFlight: Promise<void>[] = [];
  for (let seq = 0; seq < config.events; seq++) {
    const wait = start + seq * intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    const key = `chaos-${runId}-${seq}`;
    const body = JSON.stringify({
      type: seq % 2 ? "order.paid" : "user.created",
      payload: { seq },
    });
    ingest.posted++;
    inFlight.push(
      (async () => {
        const first = await postEvent(apiUrl, key, body);
        if (!first) return void ingest.gave_up++;
        // Accepted means "a 2xx reached the client". Only these events are
        // covered by the guarantee, and only these are checked.
        accepted.push(first.event_id);
        ingest.accepted++;
        if (first.status === 200) ingest.retry_found_existing++;
        // Spot-check ingest idempotency: the same key again must return the
        // same event, answered 200.
        if (Math.random() < 0.05) {
          ingest.idempotency_checks++;
          const again = await postEvent(apiUrl, key, body);
          if (again && (again.status !== 200 || again.event_id !== first.event_id)) {
            ingest.idempotency_mismatches++;
          }
        }
      })()
    );
  }
  await Promise.all(inFlight);
  return accepted;
}

// ---------------------------------------------------------------- main

async function waitForHealth(apiUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${apiUrl}/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("API did not become healthy");
}

async function main(): Promise<boolean> {
  const startedAt = Date.now();
  const dbUrl = chaosDatabaseUrl();
  const dbCmd = await dbRestartCommand();
  say(`run ${runId}, seed ${config.seed}, output in chaos/out/${runId}/`);
  say(`database ${new URL(dbUrl).pathname.slice(1)}; postgres restarts: ${dbCmd ?? dbRestartNote}`);
  await createChaosDatabase(dbUrl);

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  pool.on("error", () => {}); // idle clients die on every Postgres restart

  const receiver = await startFlakyReceiver({
    logPath: receiptsPath,
    profiles,
    random: seededRandom(config.seed + 1),
  });
  const egress = {
    ENDPOINT_ALLOW_HTTP: "true",
    ENDPOINT_ALLOW_PORTS: String(receiver.port),
    ENDPOINT_ALLOW_IPS: "127.0.0.1",
  };

  // ------------------------------------------------------------ the API
  const apiUrl = `http://127.0.0.1:${config.apiPort}`;
  const apiLog = logFd("api");
  const apiEnv = childEnv({
    ...egress,
    DATABASE_URL: dbUrl,
    PORT: String(config.apiPort),
    HOST: "127.0.0.1",
    AUTH_DISABLED: "true",
  });
  let api = spawnTs("src/server.ts", apiEnv, apiLog);
  await waitForHealth(apiUrl);

  for (const name of endpointNames) {
    const res = await fetch(`${apiUrl}/endpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url(name) }),
    });
    if (res.status !== 201) throw new Error(`endpoint registration failed: ${await res.text()}`);
    receiver.setSecret(name, ((await res.json()) as { secret: string }).secret);
  }

  // ------------------------------------------------------------ workers
  const workerLog = logFd("workers");
  const workerEnv = childEnv({ ...egress, ...worker, DATABASE_URL: dbUrl });
  type Slot = { proc: ChildProcess; state: "up" | "down" | "paused" };
  // A worker that exits on its own (not killed by the harness) is a bug
  // even if no event is lost: count it and start a replacement.
  const startWorker = (slot: Slot) => {
    const proc = spawnTs("src/worker.ts", workerEnv, workerLog);
    slot.proc = proc;
    slot.state = "up";
    proc.once("exit", () => {
      if (slot.proc === proc && slot.state !== "down" && !stopping) {
        counts.unexpected_exits++;
        startWorker(slot);
      }
    });
  };
  let stopping = false;
  const slots: Slot[] = [];
  for (let i = 0; i < config.workers; i++) {
    const slot = { state: "down" } as Slot;
    startWorker(slot);
    slots.push(slot);
  }
  const recovering = new Set<Promise<void>>();
  const track = (p: Promise<void>) => {
    recovering.add(p);
    void p.finally(() => recovering.delete(p));
  };

  const killWorker = (slot: Slot) => {
    slot.state = "down";
    slot.proc.kill("SIGKILL");
    counts.worker_kills++;
    track(
      (async () => {
        await exited(slot.proc);
        await sleep(between(100, 1000));
        startWorker(slot);
      })()
    );
  };

  // SIGSTOP past the lease: another worker re-claims the row, then this one
  // wakes up and tries to write its stale result. The claim_token fence must
  // drop that write.
  const pauseWorker = (slot: Slot) => {
    slot.state = "paused";
    slot.proc.kill("SIGSTOP");
    counts.worker_pauses++;
    track(
      sleep(leaseMs + between(2000, 4000)).then(() => {
        slot.proc.kill("SIGCONT");
        slot.state = "up";
      })
    );
  };

  let chaosOn = true;
  const faults: Promise<void>[] = [];

  faults.push(
    (async () => {
      while (chaosOn) {
        await sleep(config.workerFaultEveryMs * between(0.5, 1.5));
        const up = slots.filter((s) => s.state === "up");
        if (!chaosOn || up.length === 0) continue;
        const r = chaosRandom();
        if (r < 0.1) {
          counts.fleet_kills++;
          up.forEach(killWorker);
        } else if (r < 0.4 && up.length >= 2 && !slots.some((s) => s.state === "paused")) {
          // One pause at a time, with another worker up to re-claim the
          // paused worker's rows, so the stale write actually gets fenced.
          pauseWorker(up[Math.floor(chaosRandom() * up.length)]);
        } else {
          killWorker(up[Math.floor(chaosRandom() * up.length)]);
        }
      }
    })()
  );

  if (config.apiKillEveryMs > 0) {
    faults.push(
      (async () => {
        while (chaosOn) {
          await sleep(config.apiKillEveryMs * between(0.5, 1.5));
          if (!chaosOn) break;
          api.kill("SIGKILL");
          counts.api_kills++;
          await exited(api);
          await sleep(between(200, 1500));
          api = spawnTs("src/server.ts", apiEnv, apiLog);
          await waitForHealth(apiUrl).catch(() => {});
        }
      })()
    );
  }

  if (dbCmd) {
    faults.push(
      (async () => {
        while (chaosOn) {
          await sleep(config.dbRestartEveryMs * between(0.5, 1.5));
          if (!chaosOn) break;
          try {
            await sh(dbCmd, { cwd: root, timeout: 60_000 });
            counts.db_restarts++;
            say("postgres crash-restarted");
          } catch (err) {
            dbRestartNote = `stopped after an error: ${String(err).split("\n")[0]}`;
            say(`postgres restart failed, no more restarts: ${dbRestartNote}`);
            break;
          }
        }
      })()
    );
  }

  // ------------------------------------------------------------ ingest
  say(`ingesting ${config.events} events at ${config.eventsPerSec}/s under chaos`);
  const accepted = await ingestAll(apiUrl);
  say(`ingest done: ${ingest.accepted} accepted, ${ingest.retries} client retries`);
  await sleep(config.tailMs);
  chaosOn = false;
  await Promise.all(faults);
  while (recovering.size > 0) await Promise.all([...recovering]);
  say(
    `chaos stopped: ${counts.worker_kills} worker kills (${counts.fleet_kills} whole-fleet), ` +
      `${counts.worker_pauses} pauses, ${counts.api_kills} API kills, ${counts.db_restarts} Postgres restarts`
  );

  // ------------------------------------------------------------ drain
  const drainDeadline = Date.now() + config.drainTimeoutMs;
  let pending = -1;
  let lastSay = 0;
  while (Date.now() < drainDeadline) {
    try {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE status = 'pending'`
      );
      pending = rows[0].n;
      if (pending === 0) break;
      if (Date.now() - lastSay > 5000) {
        say(`draining: ${pending} deliveries still pending`);
        lastSay = Date.now();
      }
    } catch {
      // Postgres may still be in crash recovery.
    }
    await sleep(500);
  }
  if (pending !== 0) say(`drain timed out with ${pending} pending; the verifier will report them`);

  stopping = true;
  await Promise.all(slots.map((s) => stopChild(s.proc)));
  await stopChild(api);
  await receiver.close();

  // ------------------------------------------------------------ verify
  const nameByUrl = new Map(endpointNames.map((n) => [receiver.url(n), n]));
  const [events, deliveries, attempts] = await Promise.all([
    pool.query<{ id: string }>(`SELECT id FROM events`),
    pool.query<{ event_id: string; url: string; status: string; attempts: number }>(
      `SELECT d.event_id, ep.url, d.status, d.attempts
       FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id`
    ),
    pool.query<{ outcome: string | null; finished: boolean; n: number }>(
      `SELECT outcome, finished_at IS NOT NULL AS finished, count(*)::int AS n
       FROM delivery_attempts GROUP BY 1, 2`
    ),
  ]);
  await pool.end();

  const receipts: Receipt[] = (await readFile(receiptsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const report = verify({
    accepted,
    endpoints: endpointNames,
    eventsInDb: events.rows.map((r) => r.id),
    deliveries: deliveries.rows.map((d) => ({
      event_id: d.event_id,
      endpoint: nameByUrl.get(d.url) ?? d.url,
      status: d.status,
      attempts: d.attempts,
    })),
    receipts,
    maxAttempts,
    idempotencyMismatches: ingest.idempotency_mismatches,
  });

  const sum = (pred: (r: (typeof attempts.rows)[number]) => boolean) =>
    attempts.rows.filter(pred).reduce((n, r) => n + r.n, 0);
  const attemptStats = {
    total: sum(() => true),
    delivered: sum((r) => r.outcome === "delivered"),
    retry: sum((r) => r.outcome === "retry"),
    dead: sum((r) => r.outcome === "dead"),
    // The worker died mid-attempt; the row was re-claimed after its lease.
    abandoned_by_crash: sum((r) => r.outcome === "lease_expired" && !r.finished),
    // The worker finished after losing its lease and the fence dropped its write.
    fenced_stale_writes: sum((r) => r.outcome === "lease_expired" && r.finished),
  };

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const results = {
    run: runId,
    pass: report.pass,
    duration_sec: durationSec,
    machine: `${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, Node ${process.versions.node}`,
    config: { ...config, worker, profiles, db_restart: dbCmd ?? dbRestartNote },
    chaos: counts,
    receiver: receiver.stats,
    ingest,
    attempts: attemptStats,
    verify: { ...report, violations: report.violations.slice(0, 100) },
    violation_count: report.violations.length,
  };
  writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2) + "\n");
  const receiverFaults = Object.values(receiver.stats).reduce(
    (total, s) => total + s.error + s.hang + s.drop + s.ack_lost,
    0
  );
  const summary = renderSummary(results, report, attemptStats, receiverFaults);
  writeFileSync(`${outDir}/summary.md`, summary);
  console.log("\n" + summary);
  return report.pass;
}

function renderSummary(
  r: { run: string; duration_sec: number; machine: string; config: { seed: number; workers: number } },
  v: VerifyReport,
  a: Record<string, number>,
  receiverFaults: number
): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const of = (x: number, thing: string) => `${n(x)} ${thing}${x === 1 ? "" : "s"}`;
  const lines = [
    `# Chaos run ${r.run}`,
    "",
    `**${v.pass ? "PASS" : "FAIL"}**: ${n(v.missing)} of ${n(v.expected_deliveries)} deliveries missing` +
      ` (${n(v.accepted_events)} accepted events x ${endpointNames.length} endpoints).`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Events accepted (POST /events answered 2xx) | ${n(v.accepted_events)} |`,
    `| Deliveries expected | ${n(v.expected_deliveries)} |`,
    `| Delivered, confirmed in the receiver's log | ${n(v.delivered)} |`,
    `| Dead-lettered after ${maxAttempts} attempts | ${n(v.dead)} (${n(v.dead_by_endpoint["always-500"] ?? 0)} to the always-500 endpoint) |`,
    `| Missing (lost, stuck, or "delivered" but never received) | ${n(v.missing)} |`,
    `| Dead-lettered, though the receiver had processed it | ${n(v.dead_but_received)} |`,
    `| Duplicate deliveries (receiver processed the same webhook-id again) | ${n(v.duplicate_receipts)} (${pct(v.duplicate_rate)} of ${n(v.unique_received)} received) |`,
    `| ...after a lost 200 (the receiver's fault, injected) | ${n(v.duplicates_after_lost_ack)} |`,
    `| ...after a worker crash, pause or failed result write | ${n(v.duplicate_receipts - v.duplicates_after_lost_ack)} |`,
    `| Most copies of one delivery | ${n(v.max_copies)} |`,
    `| Bad signatures seen by the receiver | ${n(v.violations.filter((x) => x.kind === "bad_signature").length)} |`,
    `| Workers that exited without being killed | ${n(counts.unexpected_exits)} |`,
    `| Idempotency-Key spot checks (same key, same event) | ${n(ingest.idempotency_checks - ingest.idempotency_mismatches)}/${n(ingest.idempotency_checks)} |`,
    "",
    "Faults injected:",
    "",
    `- ${of(counts.worker_kills, "worker SIGKILL")} (${n(counts.fleet_kills)} of them whole-fleet), ${of(counts.worker_pauses, "SIGSTOP pause")} past the ${leaseMs / 1000} s lease`,
    `- ${of(counts.api_kills, "API SIGKILL")}, ${of(counts.db_restarts, "Postgres crash-restart")}${dbRestartNote ? ` (${dbRestartNote})` : ""}`,
    `- ${n(receiverFaults)} receiver faults (500s, hangs, dropped connections, lost 200s) out of ${n(v.receiver_requests)} requests`,
    `- ${of(a.abandoned_by_crash, "attempt")} abandoned mid-flight by a crash, ${of(a.fenced_stale_writes, "stale result")} dropped by the claim_token fence`,
    "",
    `${n(a.total)} delivery attempts in ${r.duration_sec} s; ${r.config.workers} workers; seed ${r.config.seed}; ${r.machine}.`,
    "",
  ];
  if (!v.pass) {
    lines.push("Violations (first 20):", "");
    for (const x of v.violations.slice(0, 20)) {
      lines.push(`- ${x.kind} ${x.event_id ?? ""} ${x.endpoint ?? ""} ${x.detail ?? ""}`.trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(2);
  }
);
