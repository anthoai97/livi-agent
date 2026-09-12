# Livi session storage: SQLite

Each conversation is stored in `.data/sessions/<sessionId>.sqlite`. `LIVI_DATA_DIR` overrides `.data`, which also contains `server-id`.

## Conversation structure

Livi uses the `main` lane. Its `tipId` points to the latest entry; `parentId` links each entry to its predecessor.

```text
User message → Assistant tool calls → Tool results → Assistant reply
```

Core message-entry shape:

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface MessageEntry {
  id: string;
  parentId: string | null;
  seq: number;       // Session storage sequence
  timestamp: number; // Unix milliseconds
  type: "message";
  message: AgentMessage;
  terminate?: true;
}
```

| Message role | Main fields |
| --- | --- |
| `user` | `content` (text or text/image blocks), `timestamp` |
| `assistant` | `content` (text, thinking, tool calls), `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp` |
| `toolResult` | `toolCallId`, `toolName`, `content`, optional `details`, `isError`, `timestamp` |

A tool call contains `id`, `name`, and `arguments`; `toolResult.toolCallId` references that ID. Other entry types are `compaction`, `branch_summary`, and `custom`.

Exact types: [entries](../packages/agent/src/harness/session/types.ts), [messages](../packages/ai/src/types.ts).

## Database tables

| Table | Columns |
| --- | --- |
| `sessions` | `id`, `created_at`, `parent_session_id`, `storage_version`, `metadata`, `message_count`, `usage_payload`, `next_seq` |
| `entries` | `session_id`, `id`, `parent_id`, `seq`, `type`, `custom_type`, `timestamp`, `payload` |
| `scalar_values` | `session_id`, `namespace`, `key`, `seq`, `value` |
| `list_values` | `session_id`, `namespace`, `key`, `seq`, `value` |
| `usage_ledger` | `session_id`, `id`, `seq`, `entry_id`, `adjustment`, `usage`, `details` |
| `branch_entries` | `session_id`, `branch_id`, `entry_id`, `entry_seq`, `entry_type` |
| `branch_meta` | `session_id`, `branch_id`, `tip_entry_id`, `tip_seq`, `base_branch_id`, `base_seq` |

`entries.payload` stores JSON text. Example:

```json
{
  "message": {
    "role": "user",
    "content": "Find a sofa for my room",
    "timestamp": 1789200000000
  }
}
```

Session values hold branch tips, agent execution state, Studio bindings, and saved command results. Branch tables and session totals are maintained indexes/caches. Compaction shortens model context while the UI retains full active-branch history.

Sources: [server storage setup](../livi-server/src/server.ts), [SQL schema](../packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql), [Studio state](../packages/decorator-agent/src/studio-journal.ts), [transcript](../packages/decorator-agent/src/services/transcript-provider.ts).
