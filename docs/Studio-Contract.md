# Studio contract handoff

`packages/decorator-agent/src/services/studio.ts` is the single source. Workspace consumers import `@livi/decorator-agent/contracts` or `/studio`. External Studio consumers import `@livi/studio-contracts` from the generated versioned package; do not duplicate interfaces.

Run `pnpm pack:studio --out /tmp/livi-studio-direct-contracts`. The script builds transport dependencies, creates local versioned tarballs, installs them into an isolated temporary consumer with no workspace resolution, and checks TypeScript, browser bundling, and runtime imports. `handoff.json` records the artifacts and verification. Install all listed tarballs together with `npm install --ignore-scripts --omit=optional /path/to/*.tgz` (or the equivalent pnpm command). The package currently has version 0.3.0 and protocol version 2. Changing a released contract requires a new package version. Placed objects carry nullable `product` data: a catalog ID distinct from the instance `id`, and a nullable `{ amountMinor, currency }` price. Snapshots carry a nullable `budget` of the same money shape. Unknown prices and budgets are `null`, never `0`.

## Coordinates and examples

Coordinate mapping inspected: `Livinit-ai/web-pipeline` checkout commit `d113caec1ee3bbc8b533a4b5a00840bab0c1e991`, `lib/scene3d/signatures.ts` (`applyAssetTransform`, `buildTransformOperation`) and `lib/scene3d/geometry.ts` (`roomVertexToWorldPoint`, `frontViewToYaw`). Those scene files were not edited. Companion `lib/studio-agent/snapshot.ts` was updated to publish nullable product prices from saved catalog `price_amount`/`currency` using platform currency minor units. Missing product currency defaults to USD. Saved `studio_state.custom_budget_value` is published as a USD budget; absent amounts remain null.

Use saved manifest coordinates: metres; +X right, +Y toward the back wall, +Z up; origin at the front-left floor corner of the room bounding rectangle. Polygon geometry uses this same origin, not its centroid. Dimensions are width/depth/height. Scale is dimensionless. Angles are radians. Version 2 accepts yaw only as `[0, 0, yaw]`; full Euler rotations are not evidenced or supported by the current source. For yaw alone Euler order has no effect; the contract reserves intrinsic XYZ ordering for tuple interpretation but does not claim the editor supports pitch/roll.

The editor maps manifest position `[x,y,z]` to Three.js `[x-width/2,z,depth/2-y]`. Rendered Y rotation is `manifestYaw - frontViewToYaw(asset.frontView)`; saving adds that correction back. Do not expose corrected asset-facing yaw as the saved manifest rotation. Source rounds positions to four decimals and angles to six; reversal comparison tolerances are 0.0001 metres and 0.000001 radians (angles modulo 2π).

`scripts/fixtures/studio/coordinates.json` contains illustrative contract examples, **not database-derived room data**. For a 6×4 metre room, moving `[1,1,0]` to absolute `[2,1,0]` moves one metre right; rendered positions are `[-2,0,1]` and `[-1,0,1]`. Rotating yaw from 0 to π/2 changes only the saved third rotation component; for frontView=1 the rendered yaw is also π/2.

## Connection and results

Chat prompts may include an `action`: `add_asset` carries `selectedProductId` and a positive integer `quantity`; `replace_asset` carries `selectedProductId` and the placed `targetObjectId`. Admission validates these values and pins the selection to the operation and its design/tab. Model planning and tool execution receive that same selection through room context. Interrupted or failed open operations retain it across recovery, while recovered operations cannot replay room edits. Omitting `action` keeps ordinary text prompts unchanged; add/replace execution remains follow-up work.

Each physical connection gets a private `StudioConnection.mailbox`. Register stable tab/design identity, subscribe, then call `ready(generation)`. Registration generations and request IDs are server generated. Answer current-context requests and execute requests. Reconnect creates a new generation and reads current context; it never queries previous command status. Duplicate active tab registration is rejected, and old providers cannot answer new requests.

Scene and selection publications share a monotonically increasing nonnegative sequence per registration. Studio supplies the current room context. A result's optional separately sequenced `context` updates that context; historical saved evidence does not replace newer publications. Revision is an opaque nonempty string, never numerically ordered by the agent.

Commands use absolute transforms and placed instance IDs. Studio owns edit validation and saving. `saved` reports successful persistence with actual before/after transforms and its saved scene/revision; removal has `after: null`. `rejected` reports a supplied failure, while `unknown` reports that a result could not be established. The agent checks arguments, binding, and reply identity; it does not crossvalidate the returned room or unrelated geometry.

Protocol 2 removes status mailbox requests and the status response method, `pending` command results, reconciling connection phases, and session busy/action-history fields. There is no startup inventory or durable reconciliation. A missing reply is reported without automatically resending the command or locking the next explicit user request. Old unresolved records remain historical data and do not lock designs after runtime restart.

Stop ends the response and prevents unsent work. Already sent edits may still save in Studio. Interrupted operations do not automatically replay room mutations. Completed saved tool history can support move/rotate reversal; missing outcomes are not recovered for undo.

The companion adapter uses its normal editor save path and supplies the result. No backend command-history protocol is required. JSON adapter saves are simulated; real editor/backend acceptance requires companion integration evidence.
