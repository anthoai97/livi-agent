# PostgreSQL sessions

Asynchronous PostgreSQL storage for agent sessions. Migrations run transactionally in the dedicated `livi_sessions` schema. The role needs schema/table/function/index creation and read/write permissions. Use a fresh database; existing SQLite sessions are not imported.

One active server per database/schema. Stop the old server before starting its replacement. Local reservations prevent overlapping owners within one repository; database transactions do not establish distributed ownership.

IDs use reversible UTF-16 encoding. Value addresses preserve code-point ordering (equivalent to binary UTF-8 for Unicode), including distinct lone surrogates. Shared address rules still reject NUL and empty namespaces. BIGINT conversion rejects unsafe JavaScript integers.

Commits use one pooled connection and one transaction. Failed transactions roll back; a lost COMMIT acknowledgement rejects without replay, because the durable outcome may be unknown.

## Tests

Use only a disposable database: tests destroy its `livi_sessions` schema.

```sh
TEST_SESSION_DATABASE_URL=postgres://localhost/livi_session_test pnpm --filter @earendil-works/pi-session-backend-postgres-node test
```
