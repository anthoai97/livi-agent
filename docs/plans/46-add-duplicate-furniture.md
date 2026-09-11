# #46 — Add and duplicate furniture in Studio

[Issue](https://github.com/anthoai97/livi-agent/issues/46)

Add a chosen catalog product in the requested quantity, or copy existing furniture without changing the original. Clarify ambiguous references; report success only after saving; preserve additions after reload.

## Current gaps

- `add_asset` already admits `selectedProductId` and positive integer `quantity`, pinned to the request's room/tab. Execution is missing.
- `StudioCommand`, saved results, journal records, and tool execution assume an existing object and before-transform. Creation needs explicit result evidence for new instances.
- Catalog cards only offer replacement. Real placement/save lives in the companion Studio app; this repo's JSON adapter simulates it.

## Implementation

1. **Contract and adapters.** Extend [Studio types](../../packages/decorator-agent/src/services/studio.ts) in place with add/duplicate actions: exact catalog product or source instance, quantity, and placement data. Use action-specific fields; no fabricated existing object ID or before-transform for additions. Saved creation results identify every new instance and its actual transform, revision, and snapshot. Update journal/history consumers, JSON adapter, and companion adapter together; bump contract/package versions and update [handoff docs](../Studio-Contract.md).
2. **Agent execution.** Add `add_object` and `duplicate_object` tools through the existing [execution path](../../packages/decorator-agent/src/studio-tools.ts), both `replay: "never"`. Take selected product/quantity from admitted `add_asset`; resolve explicit text references against saved catalog results, verifying exact product facts. Search/show options when no product is chosen; ask when a reference is ambiguous. Resolve duplicate sources from current inventory or one selected instance. Preserve source product, scale, rotation, and other instance properties; give each copy a new ID and requested placement. Update the system prompt and saved-action summaries so creations cannot accidentally trigger reversal of an older action.
3. **Placement and saving.** Reuse the companion editor's asset loading, clone, placement validation, and save flow. Resolve relative placement against current room evidence; clarify an ambiguous source or anchor. Prefer staging the requested copies and saving once; confirm batch behavior against the companion implementation before finalizing the contract. Return `saved` only after persistence, `rejected` for known failure, and `unknown` when completion cannot be established. Preserve binding/revision checks, bounded stale retries, cancellation, and no automatic replay after a missing reply or restart.
4. **Catalog UI.** Extend [catalog cards and prompt sending](../../livi-client/src/main.tsx) with “Add to room” and an explicit quantity, preserving quantities requested in chat. Send the existing typed `add_asset` action; keep replacement targeting intact. Show actual saved count or failure/uncertainty from tool results; allow a later explicit request for additional copies.
5. **Delivery.** Use `gh stack` for small dependent PRs: contract/adapters → agent tools → catalog UI and integration evidence. Coordinate the companion change before enabling the new actions.

## Validation

- Focused contract/tool/runtime tests: chosen product plus quantity, distinct copy IDs, unchanged source/unrelated objects, ambiguous references with no mutation, invalid quantity/product/source, and wrong room/stale revision.
- Extend existing JSON smoke scenarios: saved add/duplicate survives reload; failed save leaves no persisted additions; missing reply/restart and Stop do not replay creation. If batches can partially save, assert exact saved counts and no retry of completed copies.
- Run affected package tests, `pnpm check`, `pnpm smoke:studio`, `pnpm test:browser`, and `pnpm pack:studio` for the changed contract.
- Companion acceptance: “Add two of this lamp” and “Duplicate this chair next to the desk”; verify placement, unchanged original, two distinct new lamps, actual save failure, and reload persistence. JSON smoke alone is insufficient.

## Unresolved questions

- When placement is omitted, should Studio choose valid positions automatically or should Livi ask where? Proposed: automatic placement when supported; clarify otherwise.
- Must multiple copies save all-or-nothing, or may Livi report partial success? Proposed: one atomic save where the companion save flow supports it.
