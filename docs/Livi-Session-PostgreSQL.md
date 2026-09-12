# Livi conversation storage with PostgreSQL

**Planned:** target structure after [plan 47](plans/47-postgresql-session-backend.md) is implemented.

## Storage

Set `SESSION_DATABASE_URL` to store sessions in PostgreSQL under the `livi_sessions` schema. Without it, Livi uses SQLite. All sessions share the tables below.

```text
Local data directory (LIVI_DATA_DIR, default .data)
  server-id

PostgreSQL
  livi_sessions
    sessions
    entries
    scalar_values
    list_values
    usage_ledger
    branch_entries
    branch_meta
```

## Conversation structure

The [session entries and message types](Livi-Session-SQLite.md) stay the same. Entries link through `parentId`; the `main` lane points to the active branch's latest entry.

```text
Session → main lane → tipId
  user message → assistant tool call → tool result → assistant reply
```

An `entries` row stores structural fields in columns and entry-specific data in `payload`. For example, a user message's payload is:

```json
{
  "message": {
    "role": "user",
    "content": "Find a sofa for my room",
    "timestamp": 1789200000000
  }
}
```

## Planned tables

Columns are ported from the [SQLite schema](../packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql).

| Table | Columns |
| --- | --- |
| `sessions` | `id`, `created_at`, `parent_session_id`, `storage_version`, `metadata`, `message_count`, `usage_payload`, `next_seq` |
| `entries` | `session_id`, `id`, `parent_id`, `seq`, `type`, `custom_type`, `timestamp`, `payload` |
| `scalar_values` | `session_id`, `namespace`, `key`, `seq`, `value` |
| `list_values` | `session_id`, `namespace`, `key`, `seq`, `value` |
| `usage_ledger` | `session_id`, `id`, `seq`, `entry_id`, `adjustment`, `usage`, `details` |
| `branch_entries` | `session_id`, `branch_id`, `entry_id`, `entry_seq`, `entry_type` |
| `branch_meta` | `session_id`, `branch_id`, `tip_entry_id`, `tip_seq`, `base_branch_id`, `base_seq` |

Timestamps and sequences use `BIGINT`, checked when converted to JavaScript numbers. JSON remains serialized text. `seq` orders session storage writes, not just messages.

The first version supports one active Livi server per session database/schema; preserve the local `server-id` when replacing it. Existing SQLite sessions are not imported. If configured PostgreSQL fails, Livi reports the failure without falling back to SQLite.
