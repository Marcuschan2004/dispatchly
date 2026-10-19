import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://dispatchly:dispatchly@localhost:5433/dispatchly",
});
