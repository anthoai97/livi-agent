# Livi Agent Architecture

Status: standalone chat prototype, issue #2. Room integration and 3D decoration actions remain future work.

## Runtime

A React + Vite client connects to one Node 24 HTTP server using PI's framed CBOR protocol over binary WebSocket messages. Node serves `/api/bootstrap`, `/health`, `/ws`, and the built frontend. Vite proxies those routes during development.

The server owns a SQLite repository and one `DecoratorSession` runtime per open conversation. PI's server preserves logical server, session, and attachment routing. Chord handles typed service calls and replicated subscription snapshots and updates.

`DecoratorSession` wraps the local `AgentHarness` and its `main` lane. It owns the Livi prompt, Gemini model selection, durable prompt admission, background generation, aborts, transcript subscriptions, interrupted-operation recovery, and cleanup. Automatic compaction is disabled. Tools and active-tool lists are empty; no skills, extensions, MCP connections, or execution environment are registered. The durable core retains its upstream interfaces, while the application exposes only chat capabilities.

## Packages

| Location | Responsibility |
| --- | --- |
| `packages/client` | React chat, reconnect and subscription hydration, Markdown rendering |
| `packages/server` | HTTP, WebSocket adapter, stable server identity, SQLite ownership, shutdown |
| `packages/agent` | Copied PI agent engine and durable harness |
| `packages/decorator-agent` | DecoratorSession and browser-safe service contracts |
| `packages/session-backends/sqlite-node` | Copied PI Node SQLite backend and migrations |
| `vendor/pi/packages` | Copied AI, Chord, telemetry, protocol, client and server libraries |

Copied packages retain upstream names and resolve each other through pnpm workspace links. Model catalogs are retained in source, and migrations are copied into build output. Normal builds work without the sibling PI checkout.

## Services

Browser code imports `@livi/decorator-agent/contracts`, which has no server runtime imports.

| Service | Responsibility |
| --- | --- |
| `SessionDirectory` | Replicated conversation summaries |
| `SessionManagement` | Create, attach, and detach conversations |
| `AgentController` | Submit a message and abort by operation ID |
| `Transcript` | Replicated PI transcript and execution status |

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
