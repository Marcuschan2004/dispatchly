// Manage API keys from the command line. This is the bootstrap path: the HTTP
// API needs a key, so the first key has to come from somewhere else.
//
//   npm run api-key -- create <name>
//   npm run api-key -- list
//   npm run api-key -- revoke <id or prefix>
import { pool } from "../db.js";
import { createApiKey } from "../auth/api-keys.js";

const usage = "usage: api-key create <name> | list | revoke <id or prefix>";

async function main(args: string[]): Promise<number> {
  const [command, arg] = args;
  switch (command) {
    case "create": {
      if (!arg) break;
      const k = await createApiKey(pool, arg);
      console.log(`Created key ${k.prefix}... (${k.id}) named "${k.name}".`);
      console.log("Store it now; it is not shown again:\n");
      console.log(k.key);
      return 0;
    }
    case "list": {
      const { rows } = await pool.query(
        `SELECT id, name, prefix, created_at, last_used_at, revoked_at
         FROM api_keys ORDER BY created_at`
      );
      console.table(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          key: `${r.prefix}...`,
          created: r.created_at.toISOString(),
          last_used: r.last_used_at?.toISOString() ?? "never",
          status: r.revoked_at ? "revoked" : "active",
        }))
      );
      return 0;
    }
    case "revoke": {
      if (!arg) break;
      // Accepts the id or the displayed prefix. A prefix that matches more
      // than one key revokes nothing.
      const { rows } = await pool.query<{ id: string; prefix: string }>(
        `WITH target AS (
           SELECT id FROM api_keys
           WHERE (id::text = $1 OR prefix = $1) AND revoked_at IS NULL
         )
         UPDATE api_keys SET revoked_at = now()
         WHERE id IN (SELECT id FROM target) AND (SELECT count(*) FROM target) = 1
         RETURNING id, prefix`,
        [arg]
      );
      if (rows.length === 0) {
        console.error(`No single active key matches "${arg}".`);
        return 1;
      }
      console.log(`Revoked ${rows[0].prefix}... (${rows[0].id}).`);
      return 0;
    }
  }
  console.error(usage);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await pool.end();
}
