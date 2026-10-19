// Brings the database schema up to date. Render runs this before every
// start; locally, run it after pulling:
//
//   npm run build && npm run migrate
import { pool } from "../db.js";
import { migrate } from "../migrate.js";

try {
  const applied = await migrate(pool, { log: (msg) => console.log(`migrate: ${msg}`) });
  if (applied.length === 0) console.log("migrate: up to date");
} catch (err) {
  console.error(`migrate: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
