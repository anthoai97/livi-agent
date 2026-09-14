# #48 — Use the agent engine in web-pipeline chat

[Issue](https://github.com/anthoai97/livi-agent/issues/48)

Keep web-pipeline's chat UI; route messages, streaming, history, Stop, and product actions through `livi-server`. Use [livi-client](../../livi-client/src/main.tsx) as the working reference.

## Starting point

- web-pipeline: `components/StudioScreen.tsx` wires `ChatInterface.tsx` to `usePipelineRun.sendChatMessage` / `iterateDesign`, then `ApiClient.runChat` → `/api/chat` → pipeline SSE. History and feedback use separate authenticated APIs.
- livi-agent: bootstrap → binary WebSocket → Chord services. Agent sessions own the transcript; Studio owns room execution and saved revisions.
- `scripts/pack-studio-contracts.mjs` exports Studio contracts only. Chat contracts remain in a private workspace package.
- web-pipeline uses React 18 / Next.js; livi-client uses React 19 / Vite. Port the integration logic into existing components; do not copy the app shell or Vite configuration.
- Companion [Studio adapter #36](https://github.com/Livinit-ai/web-pipeline/issues/36) is closed, but inspected web-pipeline `main` has no obvious agent adapter/package. Locate and verify its implementation revision before relying on room actions.

## Implementation order

1. **Export usable client contracts — livi-agent.** Extend the existing packaging script and browser-safe exports with `SessionDirectory`, `SessionManagement`, `AgentController`, `Transcript`, and catalog types/helpers. Keep Studio exports in the same handoff. Resolve transcript declaration dependencies outside the workspace without shipping server runtime into the browser. Update `scripts/fixtures/studio/consumer.ts` and `docs/Studio-Contract.md`; generate versioned tarballs and install them in web-pipeline.

2. **Connect chat — web-pipeline.** Add one focused `features/chat/useAgentChat.ts` hook and a browser transport based on [transport.ts](../../livi-client/src/transport.ts). Own the hook above the chat pane so hiding it does not disconnect the session. Configure the agent base URL; fetch its `/api/bootstrap`, resolve `wsPath` against that base, and use `ws:` / `wss:` appropriately. Configure exact `STUDIO_ALLOWED_ORIGINS`; keep Next.js's existing API routes. Subscribe to server services, create/select sessions, serialize attachment, then bind session services to the captured attachment generation. Dispose subscriptions and sockets on replacement/unmount; reconnect and rehydrate without resending prompts.

3. **Replace chat state and handlers — web-pipeline.** Modify `StudioScreen.tsx` and `ChatInterface.tsx` in place. Send through `AgentController.prompt({ message, action? })`; clear the draft only after acceptance. Render `Transcript.state.snapshot.transcript` plus `operation.streamingMessage`, keyed by entry IDs. Use operation state for activity/Stop; call `requestAbort(operation.id)`. Show rejected prompts, connection loss, and failed results distinctly. Route injected prompts through this same path. Remove obsolete chat-only SSE listeners, synthetic replies, completion effects, and automatic retries once their callers move. Retain pipeline code still used for generation or other flows.

4. **Restore conversations and attach the current room — both repos.** Proposed mapping: authenticated user + workspace + room + design → selected agent session; each variant/design retains its own conversation, with explicit New chat. For local validation, persist only this selection mapping in browser storage; the agent transcript remains authoritative. Reattach on reload and recreate only explicitly missing sessions. Clear account-specific bindings on logout. Use `StudioSession.bind({ designId, tabId })` for the exact active editor tab; never choose the first connected Studio. Flush pending manual edits through the adapter before action snapshots. Freeze targets during operations; serialize later switches and ignore old callbacks. General chat works without Studio; room actions require a ready binding. Verify adapter support for every exposed action, including add/replace.

5. **Render results in existing UI — web-pipeline.** Adapt the existing product carousel to validated catalog details using livi-client's rendering logic. Send typed `add_asset` / `replace_asset` actions with the original product, quantity, object, design, and revision fields. Disable stale/wrong-design actions; mark completion only from saved tool results. Preserve Markdown, mobile composer behavior, and feedback; map feedback to stable session/entry IDs and verify its backend accepts them. Resolve old-history and pipeline-only action decisions below before removing those paths. Do not manufacture old pipeline response blocks from agent text.

6. **Complete deployment boundary — both repos.** Local integration can use the current server. Shared deployment needs authenticated connections, server-side session/Studio ownership checks, durable design-to-session mapping, and existing prompt-credit enforcement. Today `/api/chat` charges credits; direct agent WebSocket prompts bypass it. Enforce admission and idempotent charging at the server before accepting a prompt, including reconnect cases. Configure a WebSocket-capable endpoint and persistent session storage. These are prerequisites for shared rollout, not browser-only checks.

## Validation and delivery

- Packaging: `pnpm pack:studio`; isolated typecheck, browser bundle, and runtime imports must include chat services.
- web-pipeline: `pnpm type-check`, `pnpm build`, relevant existing contract checks. Respect its rule against adding unit-test files without a request.
- Browser acceptance: create chat → stream → Stop → reload; reconnect mid-response without duplicate prompts; switch designs/tabs rapidly without transcript or command leakage.
- Real Studio: save a manual move, ask about the room, select a recommendation, add/replace, then reload. Verify saved results, stale revisions, offline Studio, and save failures. Simulated JSON smoke is insufficient.
- Before shared rollout: two accounts cannot list/attach each other's sessions or Studios; rejected/duplicate admission does not double-charge. Verify feedback and the agreed old-history behavior.
- Run `pnpm check` and affected server/contract tests when changing livi-agent code. Use `gh stack` within each repo: contracts → connection/session flow → UI/room actions → access/billing and integrated evidence. Link cross-repo dependencies; update this plan as decisions land.

## Unresolved questions

- Is #48 local integration first, or production-ready migration including access control and billing?
- Should old pipeline conversations be imported into agent sessions or retained as read-only history? Proposed: read-only history; new messages use agent sessions.
- Must chat-driven generation, layout options, fit confirmation, finish edits, and edit-preview Keep/Undo work at cutover? These need explicit agent support or an agreed separate flow; do not silently remove them.
- Is the proposed per-design conversation mapping correct, and which web-pipeline revision contains the Studio adapter?
