import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://dispatchly:dispatchly@localhost:5433/dispatchly",
});

// An idle pooled client can be dropped by the server (Neon scaling to zero,
// a restart, a network blip). pg emits that on the pool, and an unhandled
// 'error' event kills the process. The pool already discards the dead client
// and opens a new one on the next query, so logging is all that's needed.
pool.on("error", (err) => {
  console.error(JSON.stringify({ level: "warn", msg: "idle database client dropped", error: err.message }));
});
