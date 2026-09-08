# Studio contract handoff

`packages/decorator-agent/src/services/studio.ts` is the single source. Workspace consumers import `@livi/decorator-agent/contracts` or `/studio`. External Studio consumers import `@livi/studio-contracts` from the generated versioned package; do not duplicate interfaces.

Run `pnpm pack:studio --out /tmp/livi-studio-contracts`. The script builds transport dependencies, creates local versioned tarballs, installs them into an isolated temporary consumer with no workspace resolution, and checks TypeScript, browser bundling, and runtime imports. `handoff.json` records the artifacts and verification. Install all listed tarballs together with `npm install --ignore-scripts --omit=optional /path/to/*.tgz` (or the equivalent pnpm command). The package currently has version 0.1.0 and protocol version 1. Changing a released contract requires a new package version.

## Coordinates and examples

Source inspected: `Livinit-ai/web-pipeline` checkout commit `d113caec1ee3bbc8b533a4b5a00840bab0c1e991`, `lib/scene3d/signatures.ts` (`applyAssetTransform`, `buildTransformOperation`) and `lib/scene3d/geometry.ts` (`roomVertexToWorldPoint`, `frontViewToYaw`). No companion source was changed.

Use saved manifest coordinates: metres; +X right, +Y toward the back wall, +Z up; origin at the front-left floor corner of the room bounding rectangle. Polygon geometry uses this same origin, not its centroid. Dimensions are width/depth/height. Scale is dimensionless. Angles are radians. Version 1 accepts yaw only as `[0, 0, yaw]`; full Euler rotations are not evidenced or supported by the current source. For yaw alone Euler order has no effect; the contract reserves intrinsic XYZ ordering for tuple interpretation but does not claim the editor supports pitch/roll.

The editor maps manifest position `[x,y,z]` to Three.js `[x-width/2,z,depth/2-y]`. Rendered Y rotation is `manifestYaw - frontViewToYaw(asset.frontView)`; saving adds that correction back. Do not expose corrected asset-facing yaw as the saved manifest rotation. Source rounds positions to four decimals and angles to six; reversal comparison tolerances are 0.0001 metres and 0.000001 radians (angles modulo 2π).

`scripts/fixtures/studio/coordinates.json` contains illustrative contract examples, **not database-derived room data**. For a 6×4 metre room, moving `[1,1,0]` to absolute `[2,1,0]` moves one metre right; rendered positions are `[-2,0,1]` and `[-1,0,1]`. Rotating yaw from 0 to π/2 changes only the saved third rotation component; for frontView=1 the rendered yaw is also π/2.

## Connection and durability

Each physical connection gets a private `StudioConnection.mailbox`. Register stable tab/design identity, subscribe to that mailbox, then call `ready(generation)`. Registration generations and request IDs are server generated. Answer the correlated saved-context request, then outstanding command-status requests. Only after this handshake and reconciliation is the design ready. Duplicate active tab registration is rejected. Reconnect creates a new generation; old providers cannot answer new requests.

Scene and selection publications share one monotonically increasing nonnegative sequence per registration. A result's saved snapshot is immutable historical evidence. Only its optional separately sequenced `context` updates live context; delayed evidence must never overwrite a newer scene/selection. Fresh context must describe saved backend state. Revision is an opaque nonempty string, never numerically ordered by the agent.

Commands use absolute transforms and placed instance IDs. `saved` means backend persistence succeeded and includes actual before/after transforms and the saved scene/revision; removal has `after: null`. `rejected` is positive evidence of no commit. `pending` and `unknown` keep the design locked. Journal persistence precedes dispatch and successful tool completion. Timeout or Stop after dispatch does not promise rollback; late results are still journaled. Restart status queries use the same command ID under the new generation. The agent never resends an uncertain mutation merely because browser memory lacks it.

The companion must establish durable backend command lookup/deduplication; frontend source does not establish that guarantee. JSON adapter saves are simulated. Database-export/model smoke and issue #7 joint real-Studio acceptance remain pending until their separate evidence is supplied.
