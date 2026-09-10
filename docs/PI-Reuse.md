# PI reuse and local adaptations

This document records what Livi copied from PI, what changed after copying, and which behavior belongs to Livi. Update it when changing copied packages, adapted services, or the upstream revision. See [package relationships](PI-Packages.md) for dependencies and [provenance](PI-Provenance.md) for attribution.

## Upstream baseline

- Repository: https://github.com/earendil-works/pi
- Revision: `da840b6216578c2a571d0374ac6a2091a83f9d91`
- Copied package version: `0.85.1`
- License: MIT; copyright and permission notice retained in [PI provenance](PI-Provenance.md#upstream-copyright-and-permission-notice).
- Original reference checkout: sibling `../pi`. Normal builds and runtime do not depend on it.

The copies retain upstream runtime source, tests, and supporting files in the eight package directories. Local differences include a supported harness turn-context API, package/build/test configuration, consolidated attribution, removed changelogs, and generated provider data. The application-level transcript fixes are outside these copied packages.

## Copied packages

| Upstream directory | Livi directory | Purpose |
| --- | --- | --- |
| `packages/agent` | `packages/agent` | AgentHarness, lanes, model/tool loop, durable operations and session interfaces |
| `packages/session-backends/sqlite-node` | `packages/session-backends/sqlite-node` | SQLite persistence and migrations |
| `packages/ai` | `packages/ai` | Model registry, provider adapters and streaming |
| `packages/chord` | `packages/chord` | Service contracts and replicated state |
| `packages/protocol` | `packages/protocol` | Routed envelopes, CBOR encoding and framing |
| `packages/client` | `packages/client` | Client connections, service calls and subscriptions |
| `packages/server` | `packages/server` | Server/session/attachment routing and connection lifecycle |
| `packages/telemetry` | `packages/telemetry` | Tracing interfaces and utilities |

All copied packages live under `packages`. Livi’s applications live separately at the root in `livi-client/` and `livi-server/`. The copies include upstream tests, documentation, scripts, and supporting files. They retain their upstream npm names. In particular, `packages/agent` is still named `@earendil-works/pi-agent-core`.

## Changes inside copied packages

| Area | Local change | Reason |
| --- | --- | --- |
| Package manifests | PI dependencies use `workspace:*`; JSON formatting changed | Resolve copied packages locally through pnpm |
| Build configuration | Updated inherited config and dependency paths | Match Livi's `packages` layout |
| Test/benchmark configuration | Updated aliases and TypeScript paths | Run against the local copied sources |
| Agent harness context | Supplies lane, operation, turn, and callback phase to planning and tool execution | Keep Studio planning independent of persisted harness execution states |
| AI build | Default `build` calls the existing `build:offline` | Avoid catalog downloads during normal builds |
| AI dependencies | Added explicit `@smithy/types` dependency at `4.18.0` | Its existing source import needs a declared dependency under pnpm isolation |
| AI catalogs | Added 39 provider JSON files and `.manifest.json` under `src/providers/data` | Retain model metadata with the source for offline builds |
| Attribution | Consolidated the MIT notice in `docs/PI-Provenance.md`; removed separate license files | Preserve upstream attribution in one place |
| Package documentation | Removed copied changelog files, their package manifest entries, and AI README instructions for writing changelog entries | Keep upstream release history out of the local packages |

The catalogs were hydrated using the pinned revision's unchanged generator on September 7, 2026, from models.dev, NVIDIA NIM, OpenRouter, and Vercel AI Gateway. The generated manifest records their hashes. The upstream TypeScript provider catalog structure was retained.

SQLite's migration-copy script and build step already existed upstream; Livi retained them. We did not rewrite SQLite persistence, change the protocol, or replace the durable harness.

## Adapted coding-agent services

Livi did not copy the full `coding-agent` package. It adapted selected files from `packages/coding-agent/src/experimental/services` into [decorator-agent services](../packages/decorator-agent/src/services).

| Service | Livi adaptation |
| --- | --- |
| `SessionDirectory` | Replicated conversation summaries |
| `SessionManagement` | Create, attach, and detach; no plugin preparation or removal API |
| `AgentController` | Submit `{ message }` and abort by operation ID |
| `Transcript` | Replicate the main lane's transcript and execution state |
| Service providers | Compose only the chat-facing services; omit coding/plugin/model-management services |

The transcript adapter also normalizes snapshots and forwarded events into JSON before Chord records state operations. Gemini can emit explicitly `undefined` optional fields such as `responseId`, `textSignature`, and `thinkingSignature`; these previously caused `ProtocolValidationError`. Normalization omits undefined properties while preserving supplied signatures for subsequent model context. PI's strict protocol validation remains unchanged.

## Livi application code

| Location | Added behavior |
| --- | --- |
| `packages/decorator-agent/src/decorator-session.ts` | Wraps AgentHarness/main lane; owns Livi prompt, Gemini registration, durable admission, background generation, abort, recovery, subscriptions, and cleanup |
| `livi-server` | Node HTTP plus WebSocket transport, bootstrap/health routes, built frontend serving, SQLite repository ownership, stable server identity, and shutdown |
| `livi-client` | React/Vite chat UI, browser WebSocket adapter, streamed Markdown, Send/Stop, conversation selection, and reconnect hydration |

The current default model is `gemini-3.8-flash`, configurable through `GEMINI_MODEL`. The application registers only Google's provider, exposes an explicit Studio/catalog tool allowlist, registers no skills/extensions/MCP/execution environment, and enables the harness's default automatic compaction. Model-facing catalog results, room context, and saved references have byte budgets; full structured details remain persisted for the UI. Catalog follow-ups read paginated persisted history, and the transcript adapter preserves visible history across compaction and awaits navigation rebasing.

The full copied agent core and other AI providers remain in source. Capabilities are restricted by Livi's wrapper and exposed services; the copied libraries have not been reduced to Gemini-only or chat-only implementations.

## Keeping this document current

Update the package inventory and local differences when copied code or application composition changes. When upgrading PI, update the upstream revision here and in [PI provenance](PI-Provenance.md), and compare against that pinned revision. Record catalog sources and refresh the generated manifest when model data changes.

Keep this document focused on the current implementation and its differences from PI. Git and pull requests provide the working history.
