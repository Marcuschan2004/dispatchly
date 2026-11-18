import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

// The public front page at "/". It is what someone sees when they open the
// live URL, so it explains the project instead of answering 401.
//
// Rendering it never touches Postgres: the page is a constant, and the status
// badge calls /health from the browser only when a person actually opens it.
// A crawler or uptime pinger hitting "/" therefore can't keep Neon awake.
//
// The inline style and script are allowed by hash, not 'unsafe-inline', so
// the Content-Security-Policy stays strict.

const STYLE = `
:root {
  --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3;
  --muted: #8b949e; --accent: #58a6ff; --ok: #3fb950; --bad: #f85149; --warn: #d29922;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 56px 24px 40px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 40px; margin: 0; letter-spacing: -0.02em; }
h1 span { color: var(--accent); }
.status { font: 13px var(--mono); color: var(--muted); border: 1px solid var(--line);
  border-radius: 999px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 8px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
.lede { font-size: 20px; color: var(--muted); margin: 18px 0 32px; max-width: 680px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
.stat { padding: 18px 16px; background: var(--panel); border-right: 1px solid var(--line); }
.stat:last-child { border-right: 0; }
.stat b { display: block; font: 600 28px var(--mono); }
.stat.zero b { color: var(--ok); }
.stat small { display: block; color: var(--muted); font-size: 13px; line-height: 1.4; margin-top: 4px; }
.caption { color: var(--muted); font-size: 13px; margin: 0 0 40px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 40px 0 14px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
.card h3 { margin: 0 0 8px; font-size: 16px; }
.card p { margin: 0; color: var(--muted); font-size: 14px; }
.flow { font: 13px/1.9 var(--mono); background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 18px 20px; overflow-x: auto; white-space: pre; color: var(--muted); }
.flow em { color: var(--text); font-style: normal; }
pre { font: 13px/1.6 var(--mono); background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 16px 20px; overflow-x: auto; margin: 0; }
pre .c { color: var(--muted); }
.links { display: flex; flex-wrap: wrap; gap: 10px 22px; }
footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
  .stat:nth-child(2) { border-right: 0; }
  .stat:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .cards { grid-template-columns: 1fr; }
  h1 { font-size: 32px; }
}
`;

const SCRIPT = `
(async () => {
  const dot = document.getElementById("dot");
  const label = document.getElementById("status-label");
  const started = performance.now();
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const ms = Math.round(performance.now() - started);
    if (res.ok) {
      dot.className = "dot ok";
      label.textContent = "API and database up · " + ms + " ms";
    } else {
      dot.className = "dot bad";
      label.textContent = "database unreachable (" + res.status + ")";
    }
  } catch {
    dot.className = "dot bad";
    label.textContent = "API unreachable";
  }
})();
`;

const REPO = "https://github.com/Marcuschan2004/dispatchly";
const DOCS = `${REPO}/blob/main/docs`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatchly · webhook delivery with zero lost events</title>
<meta name="description" content="A Postgres-backed webhook delivery service with a chaos-tested zero-lost-events guarantee, Standard Webhooks signing, SSRF protection and secret rotation.">
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Dispatch<span>ly</span></h1>
    <span class="status" role="status"><span class="dot" id="dot"></span><span id="status-label">checking live status…</span></span>
  </header>

  <p class="lede">A webhook delivery service that tests its claim of zero lost events under real crashes,
  and treats every outbound request as an attack surface. TypeScript, Fastify and Postgres 16,
  with Postgres as the only dependency.</p>

  <div class="stats" aria-label="Chaos test results">
    <div class="stat"><b>3,000</b><small>deliveries under fault injection</small></div>
    <div class="stat"><b>35</b><small>worker kill -9s, plus 2 Postgres crashes</small></div>
    <div class="stat"><b>6,971</b><small>receiver faults: 500s, hangs, lost 200s</small></div>
    <div class="stat zero"><b>0</b><small>deliveries lost</small></div>
  </div>
  <p class="caption">From <code>npm run chaos</code>, checked delivery by delivery against the database and the
  receiver's own log. <a href="${DOCS}/chaos-harness.md">How the harness works and what it can't catch</a></p>

  <h2>How it works</h2>
  <div class="flow">your app ──<em>POST /events</em> (Idempotency-Key)──▶ API
API ──one transaction: <em>event + a delivery row per endpoint</em>──▶ Postgres (the queue)
workers ──<em>FOR UPDATE SKIP LOCKED</em>, lease + claim_token fence──▶ Postgres
workers ──<em>signed POST</em> over an SSRF-checked connection──▶ receiver
failures ──<em>backoff with jitter</em>, Retry-After, dead-letter queue, replay</div>

  <h2>What's different</h2>
  <div class="cards">
    <div class="card"><h3>Reliability you can check</h3>
      <p>At-least-once delivery with leases and fencing tokens, so a crashed or stalled worker
      can't lose or overwrite a delivery. A chaos harness exits 1 if a single one goes missing.</p></div>
    <div class="card"><h3>Security on both sides</h3>
      <p>SSRF guard that also blocks DNS rebinding, Standard Webhooks HMAC signatures, replay
      protection, zero-downtime secret rotation, secrets encrypted at rest.</p></div>
    <div class="card"><h3>One moving part</h3>
      <p>No Redis or broker. Ingest and fan-out commit in one Postgres transaction, so there's
      no dual write to get wrong, and idle workers sleep instead of polling.</p></div>
  </div>

  <h2>What a receiver gets</h2>
<pre><span class="c"># every attempt and replay of an event carries the same webhook-id</span>
POST /hook HTTP/1.1
webhook-id: 0b7e4c1a-…
webhook-timestamp: 1795032000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
content-type: application/json

{"type":"order.paid","timestamp":"2026-11-18T20:00:00Z","data":{"order_id":7}}</pre>

  <h2>Read more</h2>
  <div class="links">
    <a href="${REPO}">Source on GitHub</a>
    <a href="${DOCS}/reliability-design.md">Reliability design</a>
    <a href="${DOCS}/security-delivery.md">Threat model and security</a>
    <a href="${DOCS}/chaos-harness.md">Chaos harness</a>
    <a href="${DOCS}/deploy-stack.md">Why Render, Neon and Postgres-as-queue</a>
  </div>

  <footer>Built by <a href="https://github.com/Marcuschan2004">Marcus Chan</a>.
  The API itself needs a key; this page and <a href="/health">/health</a> are public.
  Running on free tiers, so the first request after a quiet spell can take a minute.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;

function sha256(s: string): string {
  return `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
}

export const LANDING_CSP = [
  "default-src 'none'",
  `style-src ${sha256(STYLE)}`,
  `script-src ${sha256(SCRIPT)}`,
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function landingRoutes(app: FastifyInstance): void {
  app.get("/", async (_req, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", LANDING_CSP)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "public, max-age=300")
      .send(HTML)
  );
}
