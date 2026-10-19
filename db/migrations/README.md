# Migrations

`db/schema.sql` is the baseline schema. Once a database has been deployed,
don't edit it: add a numbered file here instead, such as
`0001_add_endpoint_description.sql`. `npm run migrate` applies the files it
hasn't seen yet, in name order, each in its own transaction, and records them
in the `schema_migrations` table. Render runs it before every start.

Locally, `docker compose` loads only `schema.sql` on a fresh volume, so run
`npm run build && npm run migrate` after pulling a new migration. Tests build
their database through the same runner.
