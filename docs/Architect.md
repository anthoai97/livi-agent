# Livi Agent Architecture

Status: Studio-connected decorator agent, issue #7. Headless JSON integration simulates Studio saves; real editor/backend integration and joint acceptance with web-pipeline #36 remain pending.

## Runtime

A React + Vite client connects to one Node 24 HTTP server using PI's framed CBOR protocol over binary WebSocket messages. Node serves `/api/bootstrap`, `/health`, `/ws`, and the built frontend. Vite proxies those routes during development.

The server owns a SQLite repository and one `DecoratorSession` runtime per open conversation. PI's server preserves logical server, session, and attachment routing. Chord handles typed service calls and replicated subscription snapshots and updates.

`DecoratorSession` wraps the local `AgentHarness` and its `main` lane. It owns the Livi prompt, Gemini model selection, durable prompt admission, background generation, aborts, transcript subscriptions, interrupted-operation recovery, and cleanup. Automatic compaction is disabled. Three mutation tools (`move_object`, `rotate_object`, and `remove_object`) and the read-only `get_room_context` tool are exposed. New and reopened lanes receive that allowlist at the next planning boundary. No shell, filesystem, skills, extensions, or MCP capabilities are registered.

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
| `StudioSession` | Conversation-scoped explicit binding and current scene selection |

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

`startLiviServer` owns one Studio broker shared by service providers and decorator runtimes. A physical connection registers a stable design/tab identity and receives a new generation. Its provider owns the authority to publish context and answer its private mailbox. Other connections cannot consume or settle those requests. Chat binds explicitly to a design/tab.

Studio subscribes to the mailbox before calling `ready`. Correlated requests ask for current context or execute a command. Reconnect registers a new generation and refreshes context. There is no status RPC, startup command inventory, reconciliation handshake, or per-design pending lock. Context and selection share a monotonically increasing sequence within a generation.

Studio owns the current room and saving. The agent reads that context and sends absolute action arguments with application-generated identity, conversation/design/tab binding, expected revision, and exact placed object ID. It checks basic arguments, routing, and result correlation. It reports Studio's supplied saved/error result without checking unrelated room geometry or crossvalidating the entire saved snapshot. Coordinate conventions are in [Studio-Contract.md](Studio-Contract.md).

## Action and chat lifecycle

Each action is dispatched once. A known `stale_revision` rejection of an ordinary action prompts `get_room_context`, inspection, and recalculation within the same user operation (at most two retries by prompt policy). The refreshed snapshot supplies the next model generation and its action admission; precomputed calls in the refresh batch keep their original evidence. Initial generations still fetch context automatically. Refresh stays bound to the admitted design/tab and honors cancellation; it never clears unknown-outcome or failed-reversal mutation blocks. If the reply is lost, the tool reports no result; it does not infer rollback, query history, or automatically retry the same edit in that operation. A later explicit user request can act on Studio's current context. Old unresolved records remain unchanged and do not lock rooms after a new runtime starts.

The installed harness's non-replay tool policy prevents interrupted room actions from being resent after restart, including invocations recorded under the previous replay policy. Ordinary chat admission, persistence, model response recovery, and cancellation continue. Stop prevents unsent work and ends the response; an already sent command may still save in Studio.

Move/rotate reversal uses only completed saved tool history. It checks the target's current transform against the recorded after-state and derives the previous value from saved evidence. A changed target requires clarification. No missing result is reconciled for undo. Removal restoration, general undo/redo, catalog actions, materials, and layout generation remain excluded.

## Chat presentation and verification

The client keeps separate directory and conversation subscriptions and hydrates the Studio binding/current context after reconnect. The panel shows the attached design, optional object selection, and connection availability. Missing results do not disable the next request or leave a recovery indicator running. General chat and Stop remain available offline. Structured tool internals stay out of ordinary chat text.

`STUDIO_ALLOWED_ORIGINS` is an exact-origin allowlist for Studio bootstrap and WebSocket access. Same-origin chat behavior is retained. `pnpm pack:studio --out /tmp/livi-studio-direct-contracts` creates protocol 2, package 0.2.0 contracts and transport tarballs for the companion checkout with an isolated TypeScript/browser/runtime consumer check. See [setup](../README.md#connect-a-studio).

The JSON smoke runner uses temporary server/SQLite and headless Studio fixtures. It verifies named-object actions without selection, supplied save/error outcomes, no resend after a missing reply, a subsequent explicit request, routing, completed-history reversal, and Stop. Fixtures are synthetic unless explicitly mapped from a supplied database export. Simulated saves do not prove real editor/backend behavior. No live server restart, source database mutation, or real-model mutation is part of the direct-architecture implementation verification.
