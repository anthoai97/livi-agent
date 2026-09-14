# PostgreSQL sessions

Asynchronous PostgreSQL storage for agent sessions. Migrations run transactionally in the dedicated `livi_sessions` schema. The role needs schema/table/index creation and read/write permissions. Use a fresh database; existing SQLite sessions are not imported.

One active server per database/schema. Stop the old server before starting its replacement. Local reservations prevent overlapping owners within one repository; database transactions do not establish distributed ownership.

IDs use reversible UTF-16 encoding. Value addresses preserve code-point ordering (equivalent to binary UTF-8 for Unicode), including distinct lone surrogates. Shared address rules still reject NUL and empty namespaces. BIGINT conversion rejects unsafe JavaScript integers.

Commits use one pooled connection and one transaction. Failed transactions roll back; a lost COMMIT acknowledgement rejects without replay, because the durable outcome may be unknown.

Streaming progress is not durable: commits that only append `pi.pending.assistant_frame` or set `pi.pending.tool_output` do not open a PostgreSQL transaction. Crash or reconnect mid-reply has no stored partial. Settled entries, usage, operation state, and other values still wait for COMMIT. A mixed batch persists every write, including progress deletes.

## Tests

Use only a disposable database: tests destroy its `livi_sessions` schema.

```sh
TEST_SESSION_DATABASE_URL=postgres://localhost/livi_session_test pnpm --filter @earendil-works/pi-session-backend-postgres-node test
```

## Server configuration

Set `SESSION_DATABASE_URL=postgres://role:password@host:5432/database` in the server environment. An absent variable selects SQLite; an empty, malformed, unavailable, or incompatible PostgreSQL configuration prevents startup. There is no fallback or cross-backend session discovery. Keep `LIVI_DATA_DIR` across restarts: `server-id` remains local.

The session pool is writable, bounded to ten connections, and separate from `CATALOG_DATABASE_URL`'s read-only catalog pool. Startup finishes migrations before accepting requests; shutdown drains hosted sessions before ending the pool. Migration version 1 creates the schema, tables and indexes; incompatible versions reject startup. Use standard node-postgres connection-string TLS options for remote deployments.

For direct use, await `PostgresSessionRepo.connect({ connectionString })`, then use the shared create/open/list/delete/fork contract and call `repo.close(context)` at shutdown. Metadata contains an opaque stable schema identity, never connection credentials or local paths. Opening metadata from another database/schema is rejected.

Full local validation (Node 24+, pnpm 10.17):

```sh
pnpm install --frozen-lockfile
pnpm check
TEST_SESSION_DATABASE_URL=postgres://localhost/livi_session_test pnpm test:session:postgres
pnpm test:session
```

The explicit PostgreSQL command refuses to run without a URL and runs backend conformance/failure tests plus server WebSocket restart and killed-process recovery acceptance. Root `pnpm test` still targets `@livi/*` only.

No database locks establish server ownership. Run exactly one active server per database/schema, stop it before replacement/deletion, and do not open the same session for writing through independent repositories. Distributed ownership and SQLite import remain outside this backend.
