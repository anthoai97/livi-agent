# Studio agent implementation plan

Status: proposed implementation plan; no feature code implemented by this document.

Agent issue: [livi-agent #7](https://github.com/anthoai97/livi-agent/issues/7).
Companion: [web-pipeline #36](https://github.com/Livinit-ai/web-pipeline/issues/36).

## Goal and boundaries

Use `livi-client` to chat with the decorator agent while a separately running web Studio displays and saves the room. Deliver three mutation tools: move, rotate, and remove. Reverse a previous move or rotation by calling the same tool with its recorded previous transform. Removal cannot be reversed in this scope.

This repository owns the shared connection contracts, agent server integration, durable command records, tools, and chat presentation. The companion issue owns the Studio adapter, conversion to editor operations, validation against live editor state, persistence, and command-status evidence.

Studio's backend remains the authority for the design. The agent stores command history and observed context, not a second editable design database. Studio must be connected to execute commands. Catalog search, adding/replacing/restoring furniture, layout generation, materials, a dedicated undo tool, and manual-editor history navigation are excluded.

For this repository's acceptance, use JSON smoke tests with room data exported from the user's database query. A headless adapter exercises the same connection contract and applies commands to a local JSON copy. Running the 3D Studio, loading models, visual inspection, and screenshot tests are not required. This changes the testing approach, not the production Studio connection architecture. Real editor integration and backend persistence verification belong to the companion issue.

This defines an agent implementation milestone. Issue #7 still includes joint acceptance with the real Studio: select a chair, move it, rotate it, reverse the rotation, remove it, and reload to verify persistence. Keep that criterion pending until it passes with #36, unless the issue owner explicitly changes it. Simulated JSON saves do not complete that criterion.

## Starting point

| Existing code | What we will extend |
| --- | --- |
| `packages/decorator-agent/src/decorator-session.ts` | Durable prompt admission, one main lane, recovery, cancellation, and client attachment. Tools are currently empty. |
| `packages/decorator-agent/src/services/server.ts` | Server-scoped service providers created separately for each connection. |
| `packages/decorator-agent/src/contracts.ts` | Browser-safe service exports. |
| `livi-server/src/server.ts` | Repository ownership, runtime creation, bootstrap, WebSocket handling, and shutdown. |
| `livi-client/src/main.tsx` | Conversation selection, service subscriptions, text transcript, and Stop. |
| `packages/agent/src/harness/types.ts` | Typed tools, per-turn context, stable invocation IDs, and temporary replay memos. |
| `packages/agent/src/harness/session/values.ts` | Application-owned typed values and atomic writes using existing session storage. |

Two constraints affect the implementation:

- The current transport supports client-to-server service calls and server-to-client subscription updates. It does not expose reverse RPC to invoke a service hosted by Studio. Deliver requests through a private replicated mailbox; Studio reports results with normal service calls.
- Tool replay memos are removed after completion. Cross-turn reversal and recovery after cancellation require application-owned command records that outlive an individual tool execution.

## Step 1: Define the shared contract and adapter handoff

**Purpose:** let both repositories implement against one explicit interface.

- [ ] Add a focused browser-safe Studio contract module under `packages/decorator-agent/src/services/` and export it through `contracts.ts`.
- [ ] Separate stable Studio/tab identity, design identity, conversation binding, and the current connection generation. A catalog product ID must not substitute for a placed object ID.
- [ ] Define a room snapshot with design/revision, geometry/openings, object IDs, identifying names/categories, dimensions, position/rotation/scale, and selected object IDs. Avoid model files, binary data, and unrelated catalog payloads.
- [ ] Give snapshots and selection updates a sequence within the current registration so late updates cannot replace newer context. Selection changes do not necessarily advance the saved design revision.
- [ ] Fix coordinate units, axis directions, room origin, Euler rotation order, and angle units with the Studio implementer. Verify against actual Studio conversion/rendering code; tuple types alone do not establish these conventions. Document one movement and one rotation example as contract fixtures.
- [ ] Use absolute target position/rotation in mutation commands. Relative language is resolved against a known snapshot before dispatch; replay must not add a delta again.
- [ ] Define a command envelope containing stable command ID, conversation/design/tab binding, expected revision, action, placed object ID, and action-specific arguments. Generate routing and command IDs in application code, never in model arguments.
- [ ] Define results with command identity, status, canonical saved revision, updated scene, and authoritative before/after transforms for successful moves/rotations. Distinguish rejected, still pending, saved, and unknown outcomes.
- [ ] Keep a command's saved result immutable and separate from current room context. A delayed acknowledgement or status lookup can describe an older revision; it must settle the journal without replacing a newer scene or selection. Apply registration/sequence checks to every context-bearing response, and fetch fresh saved context when ordering cannot be established.
- [ ] Define mailbox requests for fresh saved context, executing a mutation, and checking a previous command's status. Read requests also need correlation IDs and bounded waits; they are not mutation tools.
- [ ] Define structured errors for unavailable Studio, wrong binding, invalid target/arguments, stale revision, save rejection, and uncertain outcome.
- [ ] Provide a consumable build of the browser-safe contracts and required transport dependencies to `web-pipeline`. Start with versioned local package tarballs and verify an isolated consumer build; the sibling repository cannot resolve this workspace's `workspace:*` dependencies by itself. Do not copy independent contract definitions between repositories.

**Done when:** a small fake Studio consumer can import the contracts outside this workspace, and both issues agree on request/result fixtures, coordinate conventions, and durable status semantics. Whether the existing Studio backend can look up/deduplicate operation IDs must be verified in the companion issue; it is not established by frontend types alone.

## Step 2: Connect Studio and bind it to a conversation

**Purpose:** establish correct routing before adding model-driven mutations.

- [ ] Add one application-level Studio broker under `packages/decorator-agent/src/`. Construct it in `startLiviServer` and inject it into `createServerServices` and `DecoratorSession.create`.
- [ ] Add a server-scoped Studio service: registration, context publication, result reporting, and a private replicated request mailbox. Keep the mailbox private to its physical connection's provider.
- [ ] Bind registration authority to the provider closure. Do not trust a supplied tab/connection ID to acknowledge another connection's commands. Reject duplicate active tab registrations or explicitly retire the old generation.
- [ ] Expose connected Studio summaries for the chat picker and a session-scoped service for binding/unbinding a conversation and subscribing to its Studio status.
- [ ] Initially permit one controlling conversation per design and one in-flight agent mutation per design. Apply this across tabs, not just within an agent lane. Manual changes remain protected by Studio's revision check.
- [ ] Persist the chosen design/tab association using session values. Keep sockets and connection generations in memory. Reopening a conversation remembers its target but does not invent a live connection.
- [ ] Persist the target binding, including an unattached state, under an application-generated operation ID before admitting the prompt with that ID, serializing admission against binding changes. Missing admission binding on recovery must block room actions rather than adopting the conversation's current binding. Refuse target reassignment while it has an unresolved mutation; never let a delayed tool call target a newly selected room. Discard unused binding records if admission fails.
- [ ] Extend provider cleanup in place to mark its Studio offline, remove subscriptions, and settle bounded read waits. An old connection's cleanup must not remove a newer registration.
- [ ] On reconnect, require registration, new subscriptions, a fresh saved scene, and outstanding-command reconciliation before marking the design ready.
- [ ] Add explicit configured Studio origins to the server's existing WebSocket origin check. Support the same allowed origins on `/api/bootstrap` if Studio fetches it directly. Wire configuration through `main.ts` and `.env.example`; preserve existing same-origin chat behavior.

**Done when:** two fake Studio tabs can connect, chat can choose one explicitly, context updates reach only the correct conversation, and disconnect/reconnect/design switching cannot redirect requests. No changes to generic PI protocol or server routing packages should be necessary.

## Step 3: Persist commands and implement reconciliation

**Purpose:** make external edits recoverable before allowing the model to issue them.

- [ ] Add a focused command journal using existing `Session` values, for example namespaces `livi.studio.binding` and `livi.studio.command`. Keep actual before/after transforms in these records; do not introduce a second history store initially.
- [ ] Use the pair of session ID and harness `invocationId` as the logical command identity. If Studio requires UUID operation IDs, agree a deterministic mapping in Step 1. Store operation/turn identity for correlation.
- [ ] Persist the exact command, binding, observed before transform, and expected revision before making it visible to Studio. A recovered command must retain the original target and payload.
- [ ] Persist the planning snapshot before sending the model request, including the saved scene, binding, selection, and revision, keyed to the operation and generation/turn. Tool invocation identity does not exist at planning time. Recovery must load that snapshot even if the assistant response was saved before the first command record was created; missing planning evidence must prevent dispatch and require explicit replanning.
- [ ] Use `Session.mutate` to read a record and atomically commit its transition with the existing value-write helpers. Release the mutation lock before any network wait; do not call public session writers from inside a mutation callback.
- [ ] Persist an uncertain state before publishing the mutation to the mailbox. A crash between this write and actual delivery is reconciled conservatively.
- [ ] Persist the authoritative saved result before resolving the tool successfully. Duplicate identical results return the existing record; conflicting results require reconciliation rather than replacing a committed result.
- [ ] Restore bindings and unresolved records before starting recovered tool drives. On server startup, inventory stored sessions through the repository ownership path before allowing new design mutations, including records from conversations the user has not reopened. Do not open a second writer for a session already owned by a runtime.
- [ ] Reconcile on session activation and Studio reconnect independently of harness replay. Cancelled operations may never invoke their interrupted tool again.
- [ ] Block subsequent agent mutations for a design while a previous outcome is unknown. Allow context/status reads and normal conversation.

Use these application states:

| State | Meaning and permitted next step |
| --- | --- |
| `prepared` | Stored but not published; it can still be cancelled without a remote effect. |
| `outcome_unknown` | It may have reached Studio. Obtain durable status before deciding to execute again. |
| `committed` | Studio's saved result is stored locally. Return the stored result on replay. |
| `rejected` | There is positive evidence the command did not commit. Return the rejection. |
| `cancelled_before_send` | Cancelled before publication. Never dispatch it. |

For an uncertain command, a new Studio connection checks the same command ID under its new connection generation. Retired connections cannot submit new authoritative results. A fresh status response can establish the original saved outcome. Resend the same immutable command only when the adapter's durable deduplication/status contract makes this safe. A missing browser-memory entry, timeout, or unavailable status is insufficient evidence.

Stop prevents commands that have not been published. After publication, it stops agent work but does not promise rollback. Keep reconciling the saved outcome and expose it in chat even if the original turn was cancelled. Shutdown must preserve unresolved records and stop bounded waits before closing session storage.

**Done when:** persist-before-send, save-before-success, duplicate acknowledgements, and crash/reconnect recovery pass against a deterministic adapter double and real SQLite restart coverage. Mark tools `replay: "safe"` only after this path works; replay safety comes from reconciliation, not the flag alone.

## Step 4: Add room context and the three tools

**Purpose:** connect natural-language intent to the proven command path.

- [ ] Extend `DecoratorSession.create` in place with the Studio dependency and typed per-turn context. Use the harness's existing tool-context provider and system-prompt callback to supply room data to the model. No separate read-room model tool is required initially.
- [ ] Account for the harness resolving `toolContext` separately for the system prompt and tool execution, including replay. Both must use the same durable planning snapshot for that generation/turn; fetching current context again inside the tool-context provider must not change the revision attached to existing model arguments. Refresh for the next model generation after a saved result or stale rejection, including within the same admitted operation.
- [ ] Request a fresh saved snapshot before planning a decoration action. Capture the target and selection used for that action; do not silently retarget if selection changes while the model is thinking.
- [ ] Include a compact room/object summary and relevant committed action records. Treat object labels and room descriptions as data, not instructions. If context is missing or saving fails, return an unavailable state instead of using an old snapshot as current.
- [ ] Add three typed tool definitions in one focused tools module. Start with one object per invocation; the agent can issue several sequentially for an explicit multi-object request.

| Proposed tool | Model arguments | Preserved fields |
| --- | --- | --- |
| `move_object` | Object instance ID and absolute position | Rotation, scale, identity, and materials |
| `rotate_object` | Object instance ID and absolute rotation | Position, scale, identity, and materials |
| `remove_object` | Object instance ID | All other objects |

- [ ] Validate finite coordinates/angles, exact instance identity, supported action shape, and the operation's pinned binding. Reuse Studio's existing placement restrictions; do not add a layout solver or claim collision validation the adapter does not supply.
- [ ] Pass the revision used to plan the action. If the room changes, return stale context and refresh/replan explicitly; do not stamp a fresh revision onto old model arguments.
- [ ] Serialize mutations through the broker. If a model emits multiple calls planned against one revision, reject/replan later stale calls rather than silently rebasing them.
- [ ] Register only these three mutation tools and explicitly set the main lane's allowlist with `lane.setActiveTools(...)` for new and reopened conversations before starting recovered drives. Constructor options only seed new lanes; existing chats retain their stored empty allowlist. Preserve configurations already captured by in-flight generations/batches; the new allowlist applies at subsequent planning boundaries. Use current installed TypeBox/harness APIs when implementing; keep shell/filesystem capabilities unavailable.
- [ ] Update the prompt: use selection when unambiguous, ask about unclear targets/directions/distances, describe errors accurately, and claim a change only from a committed tool result. Define room-relative directions; do not infer camera-relative "left" without camera context.
- [ ] Update existing zero-tool assertions to the explicit three-tool allowlist while preserving unavailable-tool rejection coverage and ordinary chat behavior.

**Done when:** an injected model can move, rotate, and remove the intended object through the fake Studio; invalid/ambiguous/stale requests cannot produce an unintended mutation. Each subsequent turn receives the saved result of the previous action.

## Step 5: Add conversational reversal using the same tools

**Purpose:** support "move it back" and "undo that rotation" without implementing an undo stack.

- [ ] Read committed records scoped to the conversation and design. Resolve an explicit referenced action or the latest relevant action; clarify ambiguous references.
- [ ] For plain "undo that", inspect the latest action rather than skipping a removal to find an older reversible move. Explain that restoration after removal is unavailable.
- [ ] Refresh the object and compare its identity and current transform with the recorded authoritative after state. Agree numeric/angle normalization tolerances with the adapter. A newer revision caused only by unrelated objects does not by itself prevent reversal.
- [ ] Supply a checked reversal reference to the existing move/rotate execution path, so application code derives the previous value from the journal and enforces the precondition. Do not depend on the model copying coordinates from chat correctly. This can be an optional original-command reference in the same tool schema, mutually exclusive with an ordinary target transform.
- [ ] Issue the reversal as a new normal command with a new invocation identity and current expected revision. Record its before/after transform and optional original-command reference. Do not reuse the original command ID.
- [ ] If the object was removed, replaced, or manually changed, clarify instead of silently overwriting it. Studio's revision check closes the race between validation and saving.

**Done when:** moves and rotations can be reversed after reopening the session; intervening changes are detected; removal reversal never dispatches a mutation. No manual-edit undo stack, redo feature, or new undo tool is added.

## Step 6: Make attachment and action state visible in chat

**Purpose:** make the connection and actual saved outcome understandable in `livi-client`.

- [ ] Extend the existing subscription setup in `main.tsx` to show connected Studios, the conversation's selected design, selected object summary, and offline/reconciling/ready state.
- [ ] Add a small attach/change/disconnect control. Keep conversation selection separate from Studio selection, and disable binding changes while a mutation is unresolved.
- [ ] Show action progress such as reading room, moving object, waiting for save, and checking previous result. Render saved/rejected/unknown outcomes from structured service state rather than inferring them from assistant prose.
- [ ] Keep tool internals and raw room JSON out of normal messages. Preserve user and assistant text rendering and display concise action results.
- [ ] Hydrate binding and command status after reconnect without resubmitting prompts or commands. Show a late saved outcome even if Stop ended the original model response.
- [ ] Keep general chat available without an attached Studio; explain that room actions require a connection.

**Done when:** reconnect and cancellation states are visible and accurate, and a user can see which design a chat action will affect before sending it.

## Step 7: Run JSON smoke tests using a database room export

**Purpose:** verify room understanding, tool selection, commands, and resulting state without opening a 3D view.

- [ ] Take JSON exported from the user's database query as the room fixture. The exact query/export is an input still to be supplied; do not invent database tables or assume the illustrative snapshot is the database schema.
- [ ] Map that export into the shared room snapshot with explicit field mappings. Preserve instance IDs, transforms, geometry, and revision. Check units and rotation conventions against the source contract. Missing required values should produce a fixture error rather than invented defaults.
- [ ] Store selected object IDs in each smoke scenario; selection is transient UI context and may not exist in the database export.
- [ ] Add a small headless adapter that connects through the real server services, publishes the fixture, receives commands, applies only move/rotate/remove to a local JSON copy, and returns simulated saved revisions/results. No browser, Three.js, asset downloads, or writes to the source database are needed.
- [ ] Use a temporary local state/result file for the adapter's command deduplication and restart scenarios. Label its acknowledgements as simulated persistence in the smoke report; they do not establish real Studio backend behavior.
- [ ] Add a script such as `scripts/studio-json-smoke.ts` with a proposed `pnpm smoke:studio --room <export.json> --cases <scenarios.json>` entry point. This command does not exist yet. Produce machine-readable results containing each prompt, emitted commands, before/after JSON, revision, tool result, and assertions.
- [ ] Define expected object IDs, action types, changed fields, and unchanged fields independently in scenario files. Do not use the agent's own output to generate the expected answer.
- [ ] Support a real-model smoke mode for checking natural-language requests against the fixture. Assert structured behavior and numeric tolerances, not exact assistant prose. Retain injected-model tests for repeatable routing, failure, and recovery checks; those alone do not prove natural-language understanding.

Run these scenarios with object IDs and coordinates taken from the export:

| Scenario | JSON assertion |
| --- | --- |
| Ask which objects are in the room and where a named object is | Response is grounded in fixture identities/positions; no mutation occurs. |
| Reopen a conversation created before Studio tools were added, attach a Studio, and submit a new move request | The new generation exposes exactly the three supported tools and can execute the move. |
| Select an object and request a concrete move | The intended instance's position changes as requested; rotation, scale, and all other objects remain unchanged. |
| Request a rotation | Only the intended rotation changes. |
| Reverse the rotation, reopen the conversation, then reverse the earlier move | Previous values come from committed records and match the resulting JSON. |
| Change the object's transform directly in the fixture and advance its revision | Reversal or a stale command cannot silently overwrite the simulated manual edit. |
| Remove the object, then reload local adapter state | Only that instance is absent; state survives the simulated adapter restart. |
| Ask to reverse removal or refer ambiguously to multiple similar objects | No unsupported or ambiguous mutation is sent. |
| Drop the reply after the adapter saves locally, reconnect, and restart the agent process | The same command is reconciled without another edit. |
| Crash after the assistant response is saved but before its first command record; change the room before restarting | The recovered tool retains its original planning revision and fails stale; it cannot adopt the new revision for old arguments. |
| Publish newer scene/selection context before a delayed saved acknowledgement or status reply | The command outcome settles while current scene/selection remains newer. |
| Stop before dispatch and after dispatch | Command records and reported outcomes match whether an effect may have occurred. |
| Connect a second headless adapter with a different design | Commands and delayed replies cannot cross bindings. |

Extend existing tests where possible. Focus new coverage on boundary behavior:

| Area | Required evidence |
| --- | --- |
| Routing | Two connections cannot consume/ack each other's requests; retired cleanup and replies cannot affect a new registration. |
| Recovery | Crash after remote save/before reply; crash after local commit/before tool result; unresolved records from cancelled or unopened conversations. |
| Mutation correctness | Preserved transforms, strict instance IDs, stale revisions, duplicate IDs, and no mutation on save rejection. |
| Reversal | Uses stored actual transforms across reopen; rejects intervening object changes; never restores removal. |
| Headless integration | Database-export mapping, binding, connection status, late results, transcript hydration, and expected JSON after simulated save/reload. |

Use `packages/decorator-agent/test/decorator-session.test.ts`, `livi-server/test/server.test.ts`, and the existing interrupted-server fixture as starting points. The current in-memory recovery tests do not substitute for a SQLite process-restart test. Agent SQLite persistence is real in these tests; Studio persistence is simulated by the local adapter.

During implementation, run affected tests as each step lands. At completion run `pnpm check`, `pnpm test`, and the new JSON smoke command against the supplied export/scenarios; `pnpm check` already includes the build through typechecking. The existing `pnpm test:browser` covers the chat UI and may be used for affected UI regression checks; it is not the decoration acceptance flow and does not require a 3D Studio. Run copied-core or storage conformance suites only if those packages change or evidence requires them.

Update `README.md`, `docs/Architect.md`, and `.env.example` with the implemented connection setup, origin configuration, package handoff, supported actions, reversal limits, reconnect/Stop behavior, and JSON smoke invocation. Document which fields the database export must provide and distinguish simulated adapter saves from real backend saves. Keep the companion adapter's implementation in its own repository.

**Done when:** the database-derived room fixture passes the command/state scenarios and produces an inspectable JSON report, with real-model results distinguished from deterministic coverage. No 3D view testing is needed to complete this agent plan.

## Delivery order

Use `gh stack` when implementation begins to keep the agent changes reviewable. This planning task does not create implementation branches or PRs.

| PR | Contents | Exit condition |
| --- | --- | --- |
| 1 | Shared contracts, coordinate fixtures, and external-consumer package handoff | Studio implementer can build against the contract. |
| 2 | Broker, connection services, binding, and origin configuration | Correct routing/context with fake Studios. |
| 3 | Durable journal, dispatch, reconciliation, and restart coverage | External commands recover without duplicate mutation. |
| 4 | Room-aware context and move/rotate/remove tools | Deterministic agent-to-Studio action flow works. |
| 5 | Conversational reversal | Stored transform reversal works without an undo tool. |
| 6 | Chat attachment/status UI, JSON smoke runner using the database export, and setup docs | Headless command/state acceptance scenarios pass. |

The Studio adapter can be implemented alongside PRs 2–5 after PR 1 establishes the contract. Agent milestone acceptance uses the database-derived JSON fixture and headless adapter and does not wait for the 3D Studio. Real remote deduplication, editor integration, and backend persistence evidence remain the companion issue's responsibility; passing the JSON smoke tests does not establish those behaviors or close the Studio adapter issue. Issue #7's joint Studio acceptance also remains pending until the real integration passes or the issue owner explicitly revises that criterion.
