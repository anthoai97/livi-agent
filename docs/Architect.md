# Livi Agent Architecture

Status: Studio-connected decorator agent, issue #7. Headless JSON integration simulates Studio saves; real editor/backend integration and joint acceptance with web-pipeline #36 remain pending.

## Runtime

A React + Vite client connects to one Node 24 HTTP server using PI's framed CBOR protocol over binary WebSocket messages. Node serves `/api/bootstrap`, `/health`, `/ws`, and the built frontend. Vite proxies those routes during development.

The server owns a SQLite repository and one `DecoratorSession` runtime per open conversation. PI's server preserves logical server, session, and attachment routing. Chord handles typed service calls and replicated subscription snapshots and updates.

`DecoratorSession` wraps the local `AgentHarness` and its `main` lane. It owns the Livi prompt, Gemini model selection, durable prompt admission, background generation, aborts, transcript subscriptions, interrupted-operation recovery, and cleanup. Automatic compaction is disabled. Exactly three tools are exposed: `move_object`, `rotate_object`, and `remove_object`. New and reopened lanes receive that allowlist at the next planning boundary. No shell, filesystem, skills, extensions, or MCP capabilities are registered.

## Packages

| Location | Responsibility |
| --- | --- |
| `livi-client` | React chat, reconnect and subscription hydration, Markdown rendering |
| `livi-server` | HTTP, WebSocket adapter, stable server identity, SQLite ownership, shutdown |
| `packages/agent` | Copied PI agent engine and durable harness |
| `packages/decorator-agent` | DecoratorSession and browser-safe service contracts |
| `packages/session-backends/sqlite-node` | Copied PI Node SQLite backend and migrations |
| `packages/ai`, `packages/chord`, `packages/telemetry`, `packages/protocol` | Copied AI, service contracts, tracing, and wire protocol libraries |
| `packages/client`, `packages/server` | Copied PI client connections and server routing |

Livi’s applications live at the root in `livi-client/` and `livi-server/`, with shared libraries under `packages/`. Copied packages retain upstream names and resolve each other through pnpm workspace links. Model catalogs are retained in source, and migrations are copied into build output. Normal builds work without the sibling PI checkout.

## Services

Browser code imports `@livi/decorator-agent/contracts`, which has no server runtime imports.

| Service | Responsibility |
| --- | --- |
| `SessionDirectory` | Replicated conversation summaries |
| `SessionManagement` | Create, attach, and detach conversations |
| `AgentController` | Submit a message and abort by operation ID |
| `Transcript` | Replicated PI transcript and execution status |
| `StudioDirectory` | Server-scoped connected Studio labels, design/tab identities, and connection phase |
| `StudioConnection` | Registration, private per-connection request mailbox, saved context/selection publication, and correlated responses |
| `StudioSession` | Conversation-scoped explicit binding, scene selection, unresolved status, and durable action summaries |

## Conversation flow

1. The browser loads public connection configuration and completes the PI handshake.
2. It subscribes to the directory, creates or selects a conversation, then attaches and subscribes to its transcript.
3. Submission durably admits the message and operation before returning the operation ID. Concurrent prompts on the same conversation are rejected.
4. Background generation publishes transcript changes, updating the existing assistant message as text arrives.
5. Disconnecting releases attachment subscriptions; accepted work continues in the server runtime.
6. Reconnection creates fresh subscriptions. After a process interruption, reopening the conversation restores the transcript and resumes the existing operation once. It never resubmits the user message.
7. Shutdown closes subscriptions, harnesses, and SQLite connections.

## Defaults

Client `127.0.0.1:5173`, server `127.0.0.1:3001`, no login. Model credentials remain server-only. `.data/sessions` contains one SQLite file per conversation, with stable server identity beside the directory. A single process owns each data directory. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`.

## Studio routing and authority

`startLiviServer` owns one Studio broker shared by server service providers and decorator runtimes. A physical connection registers a stable design/tab identity and receives a new generation. Its provider owns the authority to publish context and acknowledge mailbox requests. Other connections cannot consume or settle its commands. The chat binds a conversation explicitly to a design/tab; at most one conversation controls a design and one agent mutation is unresolved per design.

The existing service transport has no server-to-browser RPC. Instead, Studio subscribes to a private replicated mailbox before calling `ready`. Correlated requests ask for fresh saved context, execution, or durable status. Reconnect registers a new generation, obtains fresh context, and reconciles outstanding commands before becoming Ready. Context and selection share a monotonically increasing sequence within a generation. A saved command result is immutable evidence; its old snapshot must not replace newer live context. Only an explicitly ordered context update may refresh the scene.

Studio's backend is the design authority. The agent stores observations and command evidence in session values, not a second editable room database. Commands carry application-generated identity, pinned conversation/design/tab, expected saved revision, exact placed object ID, and an absolute target. Coordinate conventions and the verified manifest-to-editor mapping are in [Studio-Contract.md](Studio-Contract.md). Position tolerance is `1e-4` metres and angle tolerance is `1e-6` radians; only yaw is supported and asset front-view correction remains the adapter's responsibility.

## Durable action lifecycle

Prompt admission pins the conversation binding under the accepted operation ID. Each planning generation persists its saved scene, selection, and revision before the model request. Tool execution uses that same evidence, including after recovery; it cannot silently adopt a newer revision for old arguments.

The journal persists each exact command before publication, transitions to `outcome_unknown` before remote delivery, and records a canonical saved result before reporting tool success. `prepared` work may be cancelled before sending. Published work stays uncertain until durable status proves saved or rejected; disconnect, missing in-memory status, or timeout does not prove failure. Startup inventories unopened conversations as well as active ones so an unresolved command continues to lock its design. Reconciliation runs independently of model continuation, allowing a saved outcome to arrive after Stop.

The same move/rotate tools reverse a committed command using its recorded actual previous transform. Reversal is a new command and first compares the current object's transform with the original saved after-state. Unrelated object changes need not prevent reversal, but a changed, removed, or replaced target does. A rejected reversal durably blocks further mutations in the same operation, including direct-coordinate fallbacks, later calls in the same batch, and replay after reopening. A new user operation is required to proceed. The adapter checks the expected revision again when saving. Removal restoration, a general undo/redo stack, catalog actions, materials, and a layout solver are excluded.

## Chat presentation and verification

The client maintains separate server directory and conversation subscriptions. It captures the session attachment generation when subscribing, hydrates Studio binding/actions on reconnect, and never resubmits prompts or mutations. The attachment panel shows the affected design and selected objects. Binding controls are disabled during an unresolved mutation or active response. General chat and Stop remain available while Studio is offline or reconciling. Only user/assistant text enters the transcript; structured room actions render separately, including late saves after cancellation.

`STUDIO_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist for Studio bootstrap and WebSocket access. Same-origin chat behavior is retained. `pnpm pack:studio --out /tmp/livi-studio-contracts` creates a consumable contract/transport handoff for the separate checkout; the generated tarballs avoid cross-repository `workspace:*` dependencies. See [setup](../README.md#connect-a-studio).

`scripts/studio-json-smoke.ts` starts real server services and a headless adapter that applies only move, rotate, and remove to an atomic local JSON state/result file. It preserves unrelated exported fields and persists command deduplication evidence across adapter and server restart. Scenario files independently declare target IDs, expected actions, numeric outcomes, and preserved fields. Reports distinguish injected model integration from real-model natural-language verification. The actual database export and explicit field mapping remain pending; checked-in fixtures are labeled synthetic. Missing required geometry, revision, instance IDs, transforms, or coordinate declarations are errors, never defaults. No source database writes or 3D UI acceptance are part of this smoke runner. Real editor validation, remote deduplication, backend persistence, and issue #7's joint Studio acceptance require the companion integration.
