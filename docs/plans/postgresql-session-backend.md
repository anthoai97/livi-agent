# PostgreSQL session persistence

**Status: planned.** Persist agent sessions in PostgreSQL while retaining one active owner per session. Conversations, branches, durable operation state, and usage survive server restart without changing agent behavior.

## Scope and decisions

- Add `packages/session-backends/postgres-node`, exporting `PostgresStorage` and `PostgresSessionRepo`.
- Reuse [Storage, SessionRepo](../../packages/agent/src/harness/session/types.ts), [StorageBackedSession](../../packages/agent/src/harness/session/session.ts), commit preparation, and fork policy. Implement asynchronous PostgreSQL queries; keep the synchronous SQLite adapter independent.
- First deployment: one active Livi server per configured session database/schema, enforced by deployment rather than database ownership locks. The host owns writable session authority; stop the old owner before replacement or deletion. Reject overlapping create/open/fork-destination/delete operations within a repository.
- No distributed ownership, leases, heartbeat, takeover, cross-server routing, SQLite import, cross-database forks, search, or generic database abstraction in this change.
- Select PostgreSQL with `SESSION_DATABASE_URL`; absent means the existing SQLite backend. A configured PostgreSQL failure must surface rather than silently switch storage. Existing SQLite sessions remain in SQLite.
- Retain the local data directory for `server-id`. PostgreSQL persistence does not make the server stateless.

## Implementation

1. **Package and schema.** Declare `pg` and its types in the new package; follow existing backend build/export conventions and ship SQL migrations. Use a dedicated `livi_sessions` schema. Port session rows, entries, scalar/list values, usage, and branch indexes from the [SQLite schema](../../packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql). Preserve parent integrity, the shared entry/usage ID namespace, and session isolation. Use `BIGINT` for timestamps/sequences with checked conversion to JavaScript numbers; initially retain serialized JSON in text columns. Verify identifier encoding and prefix ordering against the shared contract. Apply versioned migrations transactionally before serving requests; reject unsupported versions.

2. **Storage.** Implement every `Storage` method with parameterized queries and a bounded pool. Serialize admitted commits per session. Each commit uses one checked-out connection and one transaction: lock the session row, allocate its sequence range, apply ordered writes and branch projections, update statistics, then commit. Rollback must leave all durable state and sequence allocation unchanged. Batch queries where practical to limit network round trips without changing write order. Release connections on every exit; never automatically replay a commit whose outcome is unknown after connection loss.

3. **Repository and lifecycle.** Implement create/open/list/delete/fork plus backend-owned close. Metadata identifies sessions within the configured database/schema and contains no credentials or filesystem paths; reject mismatched repository identity. Open/delete of a missing session must fail without creating data. Delete only the selected session's rows in one transaction after its owner closes. Drain admitted operations before releasing local reservations; repository close attempts all session cleanups before ending its pool and reporting errors. Close one session without ending the shared pool.

4. **Forks.** Reuse the existing branch/tree copy policy, including fresh idle lane state and exclusion of operation/pending/result/usage state. Queue a same-repository source snapshot behind previously admitted commits on the storage queue, without acquiring the session mutation barrier. Capture source metadata, values, and entries in one read-only `REPEATABLE READ` transaction, including sources accessed through an independent repository. Later source writes may proceed; the snapshot must never mix commits. Publish the destination atomically and leave no partial session on failure.

5. **Server wiring.** Extend [server options and repository construction](../../livi-server/src/server.ts) and [environment configuration](../../livi-server/src/main.ts) in place. Remove the host's concrete SQLite metadata typing through a narrow typed backend boundary; preserve existing `DecoratorSession` behavior. Give the session backend its own writable pool, separate from the intentionally read-only catalog pool. Complete migrations before startup; clean up the pool on startup failure and after session shutdown. Document connection configuration, migration permissions, backend selection, and the single-server deployment requirement.

## Validation and completion

- Run `createStorageConformance` and `createSessionRepoConformance` against a real disposable PostgreSQL database. Add an explicit backend test command and required integration-test job; root `pnpm test` currently selects only `@livi/*` packages.
- Prove transaction rollback for invalid writes; sequence/statistics correctness including deletes; binary UTF-8 prefix ordering, pagination, and JSON round trips; independent sessions; duplicate local ownership rejection; and deletion preserving other sessions.
- Test same-repository fork ordering and an independent snapshot while a later source commit completes. Cover branch/tree filtering and atomic destination failure.
- Test connection loss and unknown commit outcomes without blind retries; admitted-operation draining, pool release, and startup cleanup.
- Server acceptance: create a conversation, save messages and durable state, stop the server, restart against the same database and server identity, then reopen and continue. Cover database-unavailable startup and unchanged SQLite selection when the URL is absent.
- Run the new backend suite, affected server tests, existing SQLite conformance, and `pnpm check`. Completion requires passing evidence and backend setup/run documentation; PostgreSQL persistence alone makes no multi-server safety claim.

## Delivery

Use `gh stack` for dependent PRs: package/schema/storage with conformance → repository/forks/lifecycle with conformance → server configuration, restart acceptance, and documentation. Keep each slice independently reviewable; enable PostgreSQL only after all slices pass.

## References

- [Existing host ownership contract](../../packages/agent/docs/work-packages/07-sqlite-host-ownership-live-forks.md).
- [node-postgres transactions](https://node-postgres.com/features/transactions): use one client for every statement in a transaction.
- [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html) and [snapshot isolation](https://www.postgresql.org/docs/current/transaction-iso.html): protect commit consistency and fork snapshots; they do not establish agent ownership.

## Unresolved questions

- None blocking. First version uses opt-in PostgreSQL, a fresh session store, and one active server per database/schema. Importing existing SQLite sessions and multi-server operation require separate plans.
