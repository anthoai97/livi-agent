# Plan: selected catalog replacement #27

[Issue #27](https://github.com/anthoai97/livi-agent/issues/27). User-revised scope: select a recommendation, send a replacement command to `web-pipeline`, and let its frontend update the scene through its existing replacement flow. No atomicity investigation, backend changes, or new persistence guarantees.

## Current evidence

- #26 is closed. Recommendations persist target design, revision, object ID and prior catalog ID. Cards currently expose only “View product”; no replacement selection handler exists in `livi-client/src/main.tsx`.
- `AgentPromptAction.replace_asset` carries selected product and target IDs. Admission persists it, but does not bind it to the original recommendation's design/revision.
- `studio-tools.ts` blocks all replacement mutations. The shared `StudioAction` supports move, rotate and remove only. Existing journal handles saved, rejected and unknown outcomes without replaying interrupted edits.
- Companion integration is on open [web-pipeline PR #45](https://github.com/Livinit-ai/web-pipeline/pull/45), above [#44](https://github.com/Livinit-ai/web-pipeline/pull/44), not `main`.

## Implementation sequence

1. Add a replacement button to recommendation cards. Submit the selected product and the card's saved target; retain its design association.
2. Extend the shared command and existing tool execution path to send replacement to the attached Studio. Reuse existing binding, target and outcome handling.
3. Extend the `web-pipeline` frontend parser/handler to route the command into its existing replacement flow. Frontend owns asset loading, placement and scene updates. Return the actual frontend outcome; a UI update alone must not be labeled saved.
4. Verify card selection → command delivery → intended object updated in Studio. Run relevant type/build checks and focused integration checks.

Update the consumable contract package and companion dependency together. Keep changes small; use `gh stack` if splitting is needed.

## Expected files

- Livi: `livi-client/src/main.tsx`, `packages/decorator-agent/src/services/studio.ts`, `packages/decorator-agent/src/studio-tools.ts`; selection admission files only as needed to retain the saved target/design.
- `web-pipeline`: `lib/studio-agent/executor.ts`, `types/design-v2.ts`, and its existing frontend replacement handler if wiring is needed.
- Matching contract package metadata, relevant checks and contract documentation.

## Unresolved questions

None for this scope. Reuse frontend replacement behavior and existing command checks.
