# Supabase

An optional, separately installable Phoenix plugin implementing [plugin interface v1](../../spec/plugin.md). It gives replays a working copy of Supabase, so a replay never reaches the real Supabase. It imports no Phoenix internals. Pack it with `npm pack` and install the tarball with `npm install --install-strategy=nested`, so the plugin folder holds its own `node_modules` when it is mounted in the box. Node 24 or later runs it without a build.

## How the copy works

The copy is the real thing where it can be. It runs Supabase's own MCP server, `@supabase/mcp-server-supabase` 0.17.0. Only the management API under it is redirected. `src/route.mjs` is loaded into that server with `--import` and replaces `fetch`. In a replay, every request goes to the stand-in API in `src/api.mjs` on the box's loopback.

- SQL (`execute_sql`, `apply_migration`, and the SQL behind `list_tables` and `list_extensions`) runs in a real Postgres inside the box. It is Supabase's own Postgres build: the plugin's image copies the `/nix` store of `supabase/postgres` onto Debian. Read-only SQL runs as `supabase_read_only_user`, the way the real API runs it. Other SQL runs as `postgres`.
- The Postgres is built from the moment's snapshot when the copy starts: roles and their settings, the database owner, schemas, extensions, types, functions, tables, rows, constraints, indexes, views, triggers, row level security, comments, owners and grants. It also gets the real server's settings: locale (ICU en-US), time zone, date style, statement timeout, preloaded libraries, and the text of `version()`.
- Other API requests are answered from the API replies in the snapshot. Two answers are worked out from a recorded list: an edge function or notebook that is not in the recorded list gets Supabase's "not found" reply.
- Writes stay in the copy, so a later read shows them. After a replay changes the schema, the recorded TypeScript types and advisors are no longer used.

Anything else is a miss, never a guess. The serve command answers `unsupported`, and the answer chain goes on. These are misses:

- an API request the snapshot does not hold, such as creating a branch or deploying an edge function;
- SQL or a migration that reads or writes a table whose rows the snapshot does not fully hold. A table counts as fully held only when the snapshot read all its rows. The copy runs the statement in a transaction and asks Postgres which tables it read or wrote (`pg_stat_xact_all_tables`). That covers views, functions, triggers and foreign key checks. If a partly held table is among them, the copy rolls the statement back and misses;
- SQL with its own transaction control (`begin`, `commit` and the like) while some table is partly held;
- logs after the replay wrote something, and logs for any time window other than the exact one the snapshot holds.

The server's own settings come from the moment. If the session's server ran with `--read-only`, as Johan's launcher entry does, the copy runs read-only too, and refuses writes with the same error Supabase gives.

## The snapshot

`phoenix-supabase-snapshot` (`src/snapshot.mjs`) is a stdio MCP server for taking the snapshot. It wraps the command that starts the real Supabase MCP server, for example Johan's launcher:

```json
{ "mcpServers": { "supabase": { "command": "node", "args": ["<install root>/node_modules/@phoenix/plugin-supabase/src/snapshot.mjs", "python3", "<path>/mcp-launch.py", "supabase"] } } }
```

Give the host this file as the MCP settings it reads (`phoenix mark --mcp-config`). The harness's own settings stay as they are. While the snapshot is taken, `src/route.mjs` lets through only GET requests, read-only SQL (`read_only` is forced on) and the advisors run. Every other request is refused before it leaves the machine. Each tool answer carries the API replies behind it in `_meta["phoenix/supabase-api"]`.

The server adds one read-only tool, `phoenix_database_snapshot`. It reads the database's structure and the rows of the tables the session's SQL named, with SELECT only. It also reads the rows of tables those tables point at with foreign keys, and of tables under their views. It never reads rows from the `auth` schema. It reads at most 3 rows of a table in `public` or any other product schema. Supabase's own migration lists (`storage.migrations`, `realtime.schema_migrations`, `supabase_migrations.schema_migrations`, `supabase_functions.migrations`) hold no data about people, so it reads up to 1000 rows of them. `PHOENIX_SUPABASE_ROW_LIMIT` can lower these limits, never raise them. A table cut at its limit counts as not fully held, so SQL that touches it is a miss. The capture command (`src/capture.mjs`) plans the reads: the snapshot, every read the session made, and the lists a later call may need.

The snapshot shows Supabase as it was when it was taken, not at the cut.

## The box

Build the image with the Supabase Postgres image of the project's version. `list_tables`' server and `select version()` show the version.

```sh
docker build --build-arg PG_IMAGE=supabase/postgres:17.6.1.166 -t phoenix-supabase:17 plugins/supabase
```

The serve command refuses a snapshot from another Postgres major version. The image runs as the `postgres` user, because Postgres will not start as root.

## Tests

The tests in `test/` start Supabase's own Postgres, so they run only inside the plugin image. On a plain checkout they are skipped, and the run prints why. Build the image as above, then run them in it from the repository root. Mount the whole checkout, because the plugin's installed packages link to the repository's `node_modules`:

```sh
docker run --rm -v "$PWD:/repo:ro" -w /repo/plugins/supabase phoenix-supabase:17 node --test "test/*.test.mjs"
```

## Read-only tools

`phoenix-plugin.json` lists the tools the server shows for one project, in read-only and read-write mode. It marks the 14 tools that only read as read-only. `execute_sql`, `apply_migration`, `run_notebook` and the branch, edge function and notebook tools that change something are not read-only.

## Proof boundary

Side by side with the real Supabase (48 calls on a real project), the copy's answers differ in these ways:

- `list_tables`: the order of the tables and of the foreign keys can differ. The query that Supabase's server sends has no `ORDER BY`. So the order comes from the plan Postgres picks and from where rows sit on disk. It is not table oid order, and a copy built from a snapshot can't reproduce it. Sorted by name, the answers are the same.
- `query_logs`: the copy answers only for the exact recorded request. Logs for any other time window are a miss, because the snapshot does not hold them, and an answer built from other logs would be made up. In the 48-call comparison the window had moved, so the copy missed.

- Creating an extension the project has not installed: the copy runs the agent's SQL as Supabase's own non-superuser roles, without Supabase's extension helper, so an extension such as `dblink` is refused with "Must be superuser".

Merged with a gap: a session recorded through Johan's launcher itself was never seen, and Supabase work has stopped, so it never will be. Its token is rejected and its project is paused. The moment used in the proofs was recorded through a direct start of the same server version (0.17.0) with `--read-only`. A replay never starts the server, and it matches the copy by the server name `supabase`, the same name as the launcher entry.

Not compared with the real thing: a write on the real Supabase. Nothing was ever written to a real project. The write answers were compared with a real Supabase Postgres 17.6 instead. The read-write mode was only seen on a moment whose read-only setting was changed by hand. Johan's own settings run Supabase read-only.
