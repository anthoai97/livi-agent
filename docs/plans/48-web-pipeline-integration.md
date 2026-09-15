# #48 — Agent chat in web-pipeline

[Issue](https://github.com/anthoai97/livi-agent/issues/48)

## Scope

Local integration first, confirmed by user. Use livi-client's supported features:
conversations, streaming Markdown, Stop, catalog recommendations and typed
add/replace. Replace legacy chat machinery in place; no alternate pipeline chat,
old-history import, Keep/Undo, layout, fit or finish controls in chat. Preserve
generation/editor flows outside chat.

Companion baseline: `feat/studio-agent-batch-edits`, PR #50,
`308f6a3d65169e183f0a4131952b381e7b8e1621`; includes Studio adapter/add/replace
from #44–49. PostgreSQL PR stack #58/#59/#60/#68 is out of scope.

## Implementation

1. **Contracts — livi-agent.** Export SessionDirectory, SessionManagement,
   AgentController, Transcript, catalog types/helpers and Studio together through
   `@livi/studio-contracts@0.7.0`. Bundle agent/AI/telemetry declarations; exclude
   their runtime. Source: `packages/decorator-agent/src/contracts.ts`.
   Update packaging fixture/docs. Contracts committed as `69cbdf8`.
2. **Connection/UI — web-pipeline.** One `NEXT_PUBLIC_LIVI_SERVER_BASE_URL`;
   fetch agent bootstrap and resolve its WebSocket path there. No configured
   endpoint means unavailable chat. Own `useAgentChat` above the pane. Capture
   attachment generations, serialize replacement/disposal, fence stale callbacks,
   reconnect and rehydrate without prompt replay. Keep drafts until admission.
3. **Conversation/Studio binding.** Persist selection per account, workspace,
   room, design and endpoint; memory when storage is unavailable. Use returned
   session IDs. New chat and resume; only confirmed missing sessions are recreated.
   Logout clears account selections. Bind the exact active design/tab from
   `useStudioAgent`; preserve manual flush and saved-result executor behavior.
   Freeze editor controls during operations; keep chat Stop usable during saves.
4. **Rendering/actions.** Render authoritative transcript entry IDs and streaming
   text, validated catalog details and actual tool results. Typed add quantity and
   original replacement target/revision/catalog fields; reject stale/wrong-design
   choices. Preserve mobile composer and content-based feedback. Existing feedback
   backend does not establish stable agent-entry linkage; no backend edits.

## Validation

- Contracts: `pnpm pack:studio`, isolated declarations without skipLibCheck,
  nested transcript fields, browser bundle and runtime imports. `pnpm check`.
  Focused catalog/transcript/Studio runtime tests: 90 passed.
  Initial unintended broad decorator suite: 143 passed, 2 unrelated failures
  in unchanged decorator-session tests (5s timeout; expected tool list omitted
  existing `list_catalog_brands`).
- Companion: `pnpm type-check` passed; `pnpm test:contracts` 70 passed;
  `pnpm build` passed with local agent base inlined. Clean frozen-lockfile install.
- Both production-build synthetic browser runs passed: existing integrated e2e
  (held save/editor lock/Stop, move/add quantity/duplicate, rejected save,
  reload, dropped reply, New chat/resume) and independent acceptance
  (send/stream, mid-response socket reconnect, draft preservation/no replay,
  Stop, reload, New chat/resume, move/add quantity/rejected save).
- Faux-model server and mocked product API only. Rapid design/tab switching
  was not browser-tested. Real model/backend persistence and shared auth/billing
  are not validated. Final changed e2e passed, including preserving the reading
  position during streaming.

## Shared rollout prerequisites

Authenticated connections; server-side session/Studio ownership; durable
selection mapping; prompt-credit admission and idempotent charging before prompt
acceptance; WebSocket hosting and persistent sessions. Browser account scoping
is not access control. Direct local agent prompts bypass existing `/api/chat`
charging; this work does not authorize shared deployment.

## Unresolved questions

None for local scope. Production rollout and real-backend acceptance are separate.
