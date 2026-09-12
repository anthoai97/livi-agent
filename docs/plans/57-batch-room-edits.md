# #57 — Batch room edits

[Issue](https://github.com/anthoai97/livi-agent/issues/57)

Save related room edits in one request. Six removals planned at revision 43 should save together and return revision 49, without intermediate stale-revision errors.

## Existing support

- Studio's `appendOperations` accepts 1–50 operations with one `expected_revision`. Backend validation and persistence are atomic; revisions advance by operation count.
- The companion `web-pipeline/lib/studio-agent/executor.ts` already batches add/duplicate quantities. Other Livi commands generate one operation each.
- Livi's [contract](../../packages/decorator-agent/src/services/studio.ts) carries one action per command; model-generated calls share their turn's planning revision.

## Implementation

1. **Contract.** Add an explicit ordered batch request and saved result to the existing Studio types. Share command identity, binding, and starting revision; return per-edit results plus one final revision/snapshot. Preserve before/after transforms and created IDs for supported history/undo. Bound expanded operations to 50, including add/duplicate quantities. Bump protocol/package versions; update the handoff.
2. **Agent.** Expose batching through [Studio tools](../../packages/decorator-agent/src/studio-tools.ts), reusing existing argument, product, target, and binding validation. Send one tool invocation for edits planned against the same snapshot. Keep edits requiring new model decisions in later rounds. Do not collect separate tool calls through timing-based adapter queues.
3. **Adapter.** Extend the companion executor and command parser to translate the ordered actions into one `appendOperations` call. Resolve dependent edits against staged state; validate before dispatch; adopt only the acknowledged final state. Reuse existing deterministic operation/entity IDs and save handling. No new backend batch endpoint.
4. **Results and recovery.** Update the broker, journal consumers, transcript, and JSON adapter for batch outcomes. Known rejection changes nothing. Missing acknowledgement remains unknown; never retry it automatically. A known stale rejection refreshes/replans the entire batch within existing retry limits. Stop cancels unsent work; dispatched edits may still save. Preserve supported move/rotate/replacement undo without new removal-recovery fields.
5. **Prompt and logs.** Prefer one batch for related edits such as clearing or rearranging a room. Summarize actual saved counts/actions and the final revision; avoid premature per-item success messages.

## Validation

- Six removals: one append, correct remaining objects, final revision +6, no stale retries.
- Mixed move/rotate/remove; invalid target or stale starting revision: no partial save.
- Expanded quantity limit, wrong binding, supported undo, Stop, lost acknowledgement, duplicate delivery, and restart without replay.
- Run affected tests, `pnpm check`, JSON smoke, and `pnpm pack:studio`. Verify one real companion save and reload; JSON simulation alone does not prove backend integration.

## Delivery

Use `gh stack` for small dependent changes: contract/runtime support → companion adapter and matching contract package → agent batching and integration evidence. Coordinate both repos before enabling batches.

## Unresolved questions

None. Reuse the existing atomic Studio API and its 50-operation limit.
