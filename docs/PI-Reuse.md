# PI reuse and local change tracking

Last audited: September 7, 2026, against Livi commit `0e2ba4f`.

This document records what Livi copied from PI, what changed after copying, and which behavior belongs to Livi. Update it when changing copied packages, adapted services, or the upstream revision. See [package relationships](PI-Packages.md) for dependencies and [provenance](../vendor/pi/PROVENANCE.md) for attribution.

## Upstream baseline

- Repository: https://github.com/earendil-works/pi
- Revision: `da840b6216578c2a571d0374ac6a2091a83f9d91`
- Copied package version: `0.85.1`
- License: MIT; notices retained under `vendor/pi/LICENSE`, `packages/agent/LICENSE`, `packages/session-backends/sqlite-node/LICENSE`, and `packages/decorator-agent/LICENSE`.
- Original reference checkout: sibling `../pi`. Normal builds and runtime do not depend on it.

At the audit above, every upstream tracked file in the eight copied package directories was retained. Their existing runtime source files were unchanged. Differences were package/build/test configuration, one test import, added license files, and generated provider data. The application-level transcript fix is outside these copied packages.

## Copied packages

| Upstream directory | Livi directory | Purpose |
| --- | --- | --- |
| `packages/agent` | `packages/agent` | AgentHarness, lanes, model/tool loop, durable operations and session interfaces |
| `packages/session-backends/sqlite-node` | `packages/session-backends/sqlite-node` | SQLite persistence and migrations |
| `packages/ai` | `vendor/pi/packages/ai` | Model registry, provider adapters and streaming |
| `packages/chord` | `vendor/pi/packages/chord` | Service contracts and replicated state |
| `packages/protocol` | `vendor/pi/packages/protocol` | Routed envelopes, CBOR encoding and framing |
| `packages/client` | `vendor/pi/packages/client` | Client connections, service calls and subscriptions |
| `packages/server` | `vendor/pi/packages/server` | Server/session/attachment routing and connection lifecycle |
| `packages/telemetry` | `vendor/pi/packages/telemetry` | Tracing interfaces and utilities |

The copies include upstream tests, documentation, scripts, and supporting files. They retain their upstream npm names. In particular, `packages/agent` is still named `@earendil-works/pi-agent-core`.

## Changes inside copied packages

| Area | Local change | Reason |
| --- | --- | --- |
| Package manifests | PI dependencies use `workspace:*`; JSON formatting changed | Resolve copied packages locally through pnpm |
| Build configuration | Updated inherited config and dependency paths | Match Livi's `packages` and `vendor/pi/packages` layout |
| Test/benchmark configuration | Updated aliases and TypeScript paths | Run against the local copied sources |
| Agent test | Updated the AI import in `test/harness/runtime/drive-retry-deferred.test.ts` | AI now lives under `vendor/pi/packages/ai` |
| AI build | Default `build` calls the existing `build:offline` | Avoid catalog downloads during normal builds |
| AI dependencies | Added explicit `@smithy/types` dependency at `4.18.0` | Its existing source import needs a declared dependency under pnpm isolation |
| AI catalogs | Added 39 provider JSON files and `.manifest.json` under `src/providers/data` | Retain model metadata with the source for offline builds |
| Attribution | Added MIT license files to extracted agent and SQLite packages | Preserve upstream attribution |
| Agent location | Renamed the initial `packages/agent-core` directory to `packages/agent` and updated references | Follow the requested local package layout |

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
| `packages/server` | Node HTTP plus WebSocket transport, bootstrap/health routes, built frontend serving, SQLite repository ownership, stable server identity, and shutdown |
| `packages/client` | React/Vite chat UI, browser WebSocket adapter, streamed Markdown, Send/Stop, conversation selection, and reconnect hydration |
| Root workspace/config | Node 24, TypeScript/ESM, pnpm workspace, lockfile, commands, environment example, and ignored secrets/runtime data |
| Application tests and `scripts/browser-smoke.ts` | Deterministic provider tests, WebSocket/SQLite integration, crash recovery, and browser verification |

The current default model is `gemini-3.5-flash-lite`, configurable through `GEMINI_MODEL`. The application registers only Google's provider, configures empty tools and active-tool lists, registers no skills/extensions/MCP/execution environment, and disables automatic compaction.

The full copied agent core and other AI providers remain in source. Capabilities are restricted by Livi's wrapper and exposed services; the copied libraries have not been reduced to Gemini-only or chat-only implementations.

## Change history

All entries below are from September 7, 2026.

| Livi commit | Change |
| --- | --- |
| `b065c8f` | Copied PI infrastructure, retained catalogs, and configured the workspace |
| `ab1054e` | Added DecoratorSession, adapted services, SQLite/HTTP/WebSocket composition, and tests |
| `5efa4d2` | Added React chat, browser verification, and setup/architecture documentation |
| `7637b16` | Changed the default model to Gemini 3.5 Flash-Lite |
| `e5b6509` | Fixed undefined provider fields at the Livi transcript boundary and added a regression test |
| `0e2ba4f` | Renamed the local agent directory and updated workspace/test/documentation paths |

Review stack: [foundation PR #3](https://github.com/anthoai97/livi-agent/pull/3), [server PR #4](https://github.com/anthoai97/livi-agent/pull/4), [chat/final changes PR #5](https://github.com/anthoai97/livi-agent/pull/5).

## Validation recorded

- An isolated copy without previous dependencies/builds or a sibling PI checkout passed frozen offline installation, build, and typechecks.
- After the agent directory rename, build/typechecks, 7 application tests, and 105 SQLite tests passed.
- Application coverage includes streaming, follow-up context, cancellation, provider failure, concurrent prompt rejection, conversation isolation, subscription cleanup, reconnect hydration, and SIGKILL recovery without duplicate user input.
- The serialization regression reproduced the reported protocol failure before the fix and passed afterward, including signature preservation.
- Browser verification covered two chats, switching, Stop, reload, and restart recovery.
- Live Gemini 3.5 Flash-Lite verification passed for a response, reload hydration, and follow-up without protocol errors.

These are historical results, not a claim that every upstream package's test suite was run.

## Maintaining this record

For each future PI-related change:

1. Record the date, Livi commit/PR, affected package/files, and reason in the history.
2. Identify whether it changes copied upstream code, generated data, adapted services, or Livi application composition.
3. If changing the upstream revision, update both this baseline and `vendor/pi/PROVENANCE.md`; compare against the pinned Git revision rather than an uncommitted sibling checkout.
4. Record catalog regeneration sources and refresh the generated manifest when model data changes.
5. Record the relevant validation and any remaining unverified behavior.

For source comparisons, map the upstream directories using the table above. Separate existing source changes from generated catalogs, license additions, and configuration changes. If copied runtime source is changed, update the audit statement near the beginning of this document.
