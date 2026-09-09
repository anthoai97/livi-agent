# Plan: selected catalog replacement #27

[Issue #27](https://github.com/anthoai97/livi-agent/issues/27). User-revised scope: select a recommendation, send a replacement command to `web-pipeline`, and let its frontend update the scene through its existing replacement flow. No atomicity investigation, backend changes, or new persistence guarantees.

## Starting evidence

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

## Livi implementation and validation

Implemented the targeted-card selection through the existing prompt admission, tool execution, and Studio journal. The visible message uses product name and target category. The action retains the recommendation’s design, revision, placed object and prior catalog ID. `replace_object` sends the admitted product only. Following user testing, an older recommendation now uses freshly fetched room revision and prior product while retaining its original design and placed object. Known stale revision rejections may refresh and retry. Following further user direction, room-edit validation belongs to the frontend: searches and command outcomes no longer create per-request agent locks, and undo forwards the saved original transform with the current revision. Interrupted edits still cannot replay, and unknown operations are not automatically resent. Replacement has no reversal, and success requires Studio’s supplied saved result.

Contract package 0.4.0 retains protocol 2 and adds `action: { type: "replace", catalogId, expectedCatalogId }`; `objectId` remains on the command envelope. The isolated package consumer validates replacement types, browser bundling and runtime imports.

Validation: full build/type/lint checks; 80 decorator tests; 28 server tests passed (one pgvector test skipped because the disposable database lacks that extension); 13 injected Studio scenarios; browser card click verifies exact selected product and original target despite changed editor selection, saved result, friendly message, and reload without resubmission. Local browser/adapter saves are synthetic. Companion frontend implementation and cross-repository integration evidence belong to the root/companion handoff; no backend or persistence redesign is included here.

## Companion and integration validation

The companion parser/executor consumes contract 0.4.0 and submits the existing `asset_replace` operation with the saved target and selected catalog ID. Its existing acknowledgement resolves the canonical asset snapshot; adoption updates the frontend document and its renderer loads the model. No catalog prefetch or backend change is needed. Placement, instance identity, current material, and unrelated objects are preserved.

An isolated cross-repository smoke clicked the real Livi recommendation card and used the actual PI transport, Studio connection, frontend executor and reducer. It verified no adoption before acknowledgement, exact target/product/revision, preserved placement and unrelated furniture, and no resend after chat reload. Evidence: `artifacts/issue27/cross-repo-result.json`. The model and save response were injected; this does not verify real Studio rendering or production persistence.
