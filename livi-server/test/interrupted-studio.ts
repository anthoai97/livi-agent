import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { value } from "@earendil-works/pi-agent-core/harness/session";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import type { StudioCommand, StudioCommandResult, StudioSnapshot } from "@livi/decorator-agent/contracts";

const directory = process.argv[2]!;
const repo = new SqliteSessionRepo({
	directory: join(directory, "sessions"),
	databaseFactory: createNodeSqliteFactory(),
});
const session = await repo.create({}, context);
const binding = { designId: "restart-design", tabId: "restart-tab" };
const snapshot: StudioSnapshot = {
	designId: binding.designId,
	revision: "revision-1",
	geometry: {
		floor: [
			[0, 0],
			[4, 0],
			[4, 4],
			[0, 4],
		],
		height: 2.8,
	},
	openings: [],
	objects: [
		{
			id: "chair",
			name: "Chair",
			category: "chair",
			dimensions: [1, 1, 1],
			position: [1, 1, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
	],
	selectedObjectIds: ["chair"],
};
await session.setValue(value("livi.studio.binding"), binding, context);
const command: StudioCommand = {
	commandId: JSON.stringify([session.metadata.id, "invocation-1"]),
	conversationId: session.metadata.id,
	binding,
	expectedRevision: snapshot.revision,
	objectId: "chair",
	action: { type: "move", position: [2, 1, 0] },
};
const before = {
	position: snapshot.objects[0]!.position,
	rotation: snapshot.objects[0]!.rotation,
	scale: snapshot.objects[0]!.scale,
};
// Seed the old protocol record verbatim in an isolated test database.
const record = {
	command,
	operationId: "stopped-operation",
	turnId: "turn-1",
	invocationId: "invocation-1",
	observedBefore: before,
	state: "outcome_unknown",
	result: null,
	createdAt: 1,
};
await session.setValue(value("livi.studio.command", command.commandId), record, context);
const after = { ...before, position: [2, 1, 0] as [number, number, number] };
const result: StudioCommandResult = {
	commandId: command.commandId,
	status: "saved",
	revision: "revision-2",
	snapshot: { ...snapshot, revision: "revision-2", objects: [{ ...snapshot.objects[0]!, ...after }] },
	before,
	after,
};
// Simulated adapter saves externally; agent has not received this result when killed.
await writeFile(join(directory, "simulated-adapter.json"), JSON.stringify({ command, result, record }));
process.send?.({ type: "saved-without-ack", sessionId: session.metadata.id });
setInterval(() => {}, 1000);
