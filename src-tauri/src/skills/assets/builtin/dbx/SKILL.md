---
name: dbx
description: "Explore and query the user's external databases through the local dbx client — list managed connections, inspect schemas, and run read-only SELECTs on postgres, mysql, sqlite, or another dbx-managed type. Data already loaded into the workspace belongs to the built-in SQL tools."
---
Use the `dbx` tool whenever a task needs data that lives outside the workspace, in a database the user manages through their dbx client (postgres, mysql, sqlite, mongodb, redis, and more). Data already loaded into the workspace belongs to the built-in SQL tools; dbx is the external channel.

Pass the subcommand and its arguments as the `args` list, one argument per element (do not pre-join them into a single shell-style string). There is no shell between you and the CLI: no quoting, no `$` interpretation -- every element lands verbatim. Example: `args: ["query", "analytics-pg", "SELECT count(*) FROM orders", "--format", "csv", "--limit", "1000"]`.

## Exploration flow

Connection → schema → context, before any query:

1. `connections list` -- the connections the user manages (names and types; the listing never contains credentials).
2. `schema list` / `schema describe` -- the schemas behind a connection.
3. `context` -- the compressed schema context to hold while writing SQL.

When the environment is unknown or a call misbehaves, run `doctor --json` first. When support for a database type is unclear, run `capabilities --json` before guessing syntax or flags.

## Data egress

`--format csv` is the egress lane; `--json` is for small introspection results, not data movement.

- Bounded probing: `query <conn> "SELECT ..." --format csv --limit N` -- always carry an explicit `--limit` while exploring; widen it only after the shape and size are known.
- Large results: when stdout exceeds the output cap, the full output is kept in a `tool_output/` file and the truncation marker in the result names its path. Reference that file in `materialize` SQL (`FROM read_csv_auto('<path>')`) to load it into the working set -- do not page a huge result through repeated bounded queries.

## Read-only by default

Queries run read-only unless the user's request says otherwise:

- Write statements need `--allow-writes`; dangerous statements (`DROP` / `TRUNCATE` / `ALTER`, plus `COPY`, which dbx conservatively classifies as dangerous) additionally need `--allow-dangerous-sql`.
- When the user asks for a write, put the flag in `args` yourself -- the approval card shows the full argv, so the flags ARE the approval surface and the user approves exactly what will run.
- When a call fails with `SQL_BLOCKED`, do not add the flags on your own initiative and do not switch clients or connections to route around the refusal -- state the block to the user and let them decide.
- Never print connection secrets; the connection listing carries none, and a database tool call is not the place to go looking for credentials.

## Bridge connections

Connection types beyond dbx's direct ones reach their database through the user's bridge (a running DBX Desktop, or a `DBX_WEB_URL` endpoint). A `DBX_NOT_RUNNING` error on such a connection means the bridge is down, not that the database is gone: tell the user to start DBX Desktop (or set `DBX_WEB_URL`) instead of retrying the call.
