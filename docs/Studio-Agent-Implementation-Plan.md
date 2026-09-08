# Studio agent direct-action scope

This replaces the original reconciliation/recovery plan at the user's explicit request. Studio owns the current room and saving. The agent controls conversation, reads Studio context, invokes an action once, and reports Studio's supplied result.

Agent issue: [livi-agent #7](https://github.com/anthoai97/livi-agent/issues/7). Companion Studio implementation: [web-pipeline #36](https://github.com/Livinit-ai/web-pipeline/issues/36).

## Responsibilities and supported flow

The agent repository owns contracts, connection routing, chat persistence/cancellation, the three decoration tools, and chat presentation. Studio owns editor operations, current room state, save validation, and persistence. There is no agent-maintained room database, whole-room post-save crossvalidation, command-status service, or recovery handshake.

A user can say “move the sofa 0.5 metres right” with nothing selected. The model chooses the placed instance from Studio's named object inventory and asks only if the reference is ambiguous. Selection remains an optional hint. Move, yaw rotation, and remove are supported. Catalog actions, adding/restoring objects, materials, and layout generation remain outside scope.

The agent retains basic argument and binding checks: finite action values, exact placed object identity, current design/tab routing, and command correlation. Studio decides whether the edit saves. Supplied success/error results are reported directly without validating unrelated geometry or comparing every field in the returned room.

## Wire contract and connection

Protocol version 2 and `@livi/studio-contracts` 0.2.0 are breaking replacements for version 1. Keep registration, generation fencing, private mailbox subscription, context/selection publication, and execution replies. Mailbox requests are only context and execute; there is no status request or status response method. Remove pending results, reconciling phases, session busy fields, and action-history presentation. Results remain saved, rejected, or unknown.

Register the design/tab, subscribe, and call `ready`. Reconnection obtains current Studio context without looking up previous commands. Preserve ordinary ownership/correlation checks so one physical connection cannot answer another's request.

## Delivery, missing replies, and restart

Send each action once. A dropped connection or timeout means no result was received, not that Studio rolled the edit back. Do not automatically retry that edit within the same user operation. The next explicit user request is allowed and reads current Studio state.

Remove startup command inventory, per-design unknown locks, durable reconciliation, and indefinite recovery UI. Existing historical unresolved records remain untouched and cease locking rooms when the new runtime starts; do not relabel them saved/failed and do not migrate a live SQLite database.

Use the installed harness's non-replay tool support. Ordinary chat persistence and interrupted model response recovery remain. A recovered operation must not resend room mutations. Native non-replay policy also protects interrupted invocations recorded by the previous runtime. Retain completed saved history only for undo; no pending receipt is required.

Stop cancels unsent work and the model response. A command already sent may still save. There is no follow-up reconciliation after cancellation or disconnect.

## Saved move/rotate reversal

Keep useful reversal through the existing move/rotate tools using already completed saved tool history. Compare only the target's current transform against its recorded after-state before using the recorded before-state. An intervening target edit requires clarification. Never recover missing outcomes to make undo work, and never restore a removed object.

## Verification and delivery

Replace acceptance tests for reconciliation and pending locks with proportional direct-flow regressions:

- An old unresolved record does not lock the current room after a new runtime starts.
- Reconnect requests current context and never command status.
- A lost reply is not automatically resent, including after restart; a new explicit user request can edit.
- A named object works with no manual selection.
- Supplied saved and error results are preserved; ordinary chat and Stop still work.
- Completed move/rotate history can support reversal without status lookup.

Use deterministic providers and temporary SQLite/JSON fixtures. Run affected tests, agent/client builds, and the isolated package consumer checks. Do not restart live user servers, kill their processes, write their databases, or perform real-model mutations. Synthetic adapter saves do not establish real Studio/backend acceptance. Database-derived fixture acceptance and joint real Studio acceptance require their actual inputs and evidence.

Publish a draft followup through `gh stack` above `feat/studio-action-copy` (PR #13). Do not merge, deploy, or post comments. Generate reproducible tarballs into the new `/tmp/livi-studio-direct-contracts` directory, preserving prior artifacts. Deliver exact package versions, hashes, and the manifest to the companion implementer.
