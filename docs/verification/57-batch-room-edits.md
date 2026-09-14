# #57 handoff

Local diffs only; no implementation-agent Git mutations. Root owns stacking. Unrelated `docs/plans/48-web-pipeline-integration.md` excluded.

## Logical commit groups

1. Livi contract/runtime: protocol 1, package 0.6.0; ordered command/results, broker outcome checks, unknown-batch replay fence and stale retry limit. Files: `services/studio.ts`, `studio-broker.ts`, `studio-journal.ts`, package manifest, protocol fixture updates, isolated consumer, contract handoff.
2. Companion adapter/package: `types/design-v2.ts`, `lib/studio-agent/executor.ts`, execution contract tests, 0.6.0 vendor tarball, package/lock. Ordered staging → one existing atomic append → ordered acknowledged results → final adoption. Replace obsolete 0.5.0 tarball.
3. Livi tools/evidence: `studio-tools.ts`, runtime/tool-list tests, client transcript status, JSON adapter/runner/fixtures, this verification record. Shared validation, indexed supported undo, one saved summary, whole-batch stale replan.

## Checks

- `pnpm check`: passed (lint, builds, workspace type-checks).
- Decorator tests: 121 passed.
- Server tests: 29 passed, 1 skipped.
- Companion targeted execution/connection tests: 37 passed; `pnpm type-check`: passed.
- Injected JSON smoke: 5 batch scenarios and 19 existing scenarios passed. Batch coverage: six removals 43 → 49 with one save, remaining-object preservation, Stop before/after dispatch, lost acknowledgement/restart without replay, multiple creates, move → remove. Intermediate result checks and intact final snapshot comparison.
- `pnpm pack:studio --out /tmp/livi-protocol1-contracts`: isolated TypeScript, browser bundle, runtime import passed, including batch command/result. Installed companion tarball SHA-256: `b3000982abb4ec1bcd10769318791728aef7826cb12ae934ca40d68eb51daa20`.

## Protocol 1 alignment

The contract is unreleased; package 0.6.0 keeps current protocol 1 and unchanged batch behavior. `pnpm check` and isolated consumer pack passed. Affected decorator tests: 88 passed; targeted server/broker tests: 10 passed. Injected batch smoke: 5 scenarios passed at protocol 1 over real transport, with simulated JSON persistence. Companion `pnpm type-check` and four connection tests passed. Offline pnpm reinstall used `--frozen-lockfile --ignore-scripts --force --config.optimistic-repeat-install=false`; installed JS/types/manifest match the tarball, and both lockfile integrity values match its SHA-512. Existing live save proof below covers the unchanged executor; it was not rerun for this alignment.

## Real persistence evidence

Root ran the changed companion executor against local HTTP backend, then fresh GET reload. [Sanitized report](57-batch-room-edits-live.json): six removals, one append, revision 43 → 49, one adoption; reload equals acknowledgement. Invalid target/stale revision dispatch nothing; duplicate delivery adds no append. Existing source unchanged; separate unsaved E2E fixture retained.

API persistence proof only. No browser UI or real model generation was tested. Synthetic smoke uses injected model responses and JSON Studio saves; Livi transport/SQLite are real.

## Limits

- New created IDs require a later model round. Existing targets resolve against preceding staged edits.
- Replacement → duplicate uses the new catalog ID. Explicit one-copy placement can proceed; spacing/defaults depending on unresolved new dimensions require a later round.
- Move/rotate/replacement undo retains ordered saved evidence and uses `originalEditIndex`; remove/add/duplicate remain unsupported for direct undo. No removal recovery fields.
- Unknown batch blocks further edits in its request; no automatic replay after restart. Known stale batches allow two retries after replanning. A new explicit request may use fresh state.

## Pre-PR checks after simplification and review fixes

- Livi `pnpm check`: passed. Agent: 138 tests; server: 37 passed, 1 pgvector skip; client rendering: 5 passed.
- Isolated contract/runtime PR layer: 113 agent tests and full checks passed; added broker regression tests also type-check in that layer.
- Companion: 37 execution/connection tests, type-check and targeted lint passed; contract/vendor unchanged by simplification.
- Five injected JSON batch scenarios passed after simplification. Live API evidence above remains the persistence proof; no browser or real-model test added.
- Review fixes: settle malformed saved replies immediately as unknown; preserve valid outcomes despite malformed optional context; remove UUID-associated punctuation while preserving ordinary parentheses/code; reserve one admitted add across batch/individual calls, permitting rejected/cancelled retries; reject repeated replacements within one admitted batch.
- Claude `/code-review` via Herdr: simplification reviewed, confirmed findings fixed, focused re-review reports no actionable findings. Add reservations use the existing serialized prepare path.
