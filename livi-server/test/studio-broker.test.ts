import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { StudioBroker } from "@livi/decorator-agent";
import type { StudioCommand, StudioCommandResult, StudioSnapshot } from "@livi/decorator-agent/contracts";

const snapshot: StudioSnapshot = {
	designId: "design-a",
	revision: "saved-1",
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
			id: "chair-instance",
			name: "Chair",
			category: "chair",
			dimensions: [1, 1, 1],
			position: [1, 1, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
	],
	selectedObjectIds: ["chair-instance"],
};
async function adapter(broker: StudioBroker, tabId = "tab-a", designId = "design-a") {
	const attachment = broker.attach();
	const { generation } = await attachment.service.register(
		{ tabId, designId, label: tabId, contractVersion: 2 },
		context,
	);
	await attachment.service.ready(generation, context);
	await attachment.service.publishContext(
		{ generation, sequence: 0, snapshot: { ...structuredClone(snapshot), designId } },
		context,
	);
	return { ...attachment, generation, binding: { tabId, designId } };
}
function command(): StudioCommand {
	return {
		commandId: "command-a",
		conversationId: "chat-a",
		binding: { designId: "design-a", tabId: "tab-a" },
		objectId: "chair-instance",
		expectedRevision: "saved-1",
		action: { type: "move", position: [2, 1, 0] },
	};
}
function saved(): StudioCommandResult {
	const before = snapshot.objects[0]!;
	const after = { ...before, position: [2, 1, 0] as [number, number, number] };
	return {
		commandId: "command-a",
		status: "saved",
		revision: "saved-2",
		snapshot: { ...structuredClone(snapshot), revision: "saved-2", objects: [after] },
		before,
		after,
	};
}

test("private mailboxes preserve generation authority and newer Studio context", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	const b = await adapter(broker, "tab-b", "design-b");
	const pending = broker.execute(command(), context);
	const request = a.service.mailbox.value!.requests[0]!;
	assert.equal(request.type, "execute");
	assert.deepEqual(b.service.mailbox.value!.requests, []);
	await assert.rejects(
		b.service.respond(
			{ requestId: request.requestId, generation: b.generation, type: "result", result: saved() },
			context,
		),
		/this connection/,
	);
	const newer = { ...structuredClone(snapshot), revision: "saved-3", selectedObjectIds: [] };
	await a.service.publishContext({ generation: a.generation, sequence: 3, snapshot: newer }, context);
	await a.service.respond(
		{
			requestId: request.requestId,
			generation: a.generation,
			type: "result",
			result: saved(),
			context: { generation: a.generation, sequence: 1, snapshot },
		},
		context,
	);
	assert.equal((await pending).status, "saved");
	assert.equal(broker.getState(a.binding).snapshot?.revision, "saved-3");
	assert.deepEqual(broker.getState(a.binding).snapshot?.selectedObjectIds, []);
	a.release();
	const replacement = await adapter(broker);
	a.release();
	assert.equal(broker.getState(replacement.binding).phase, "ready");
	await assert.rejects(
		a.service.publishContext({ generation: a.generation, sequence: 100, snapshot }, context),
		/Retired/,
	);
});

test("lost replies settle without status requests or mutation resend on reconnect", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	const pending = broker.execute(command(), context);
	assert.equal(a.service.mailbox.value!.requests[0]!.type, "execute");
	a.release();
	await assert.rejects(pending, /Studio disconnected/);
	const replacement = await adapter(broker);
	assert.equal(broker.getState(replacement.binding).phase, "ready");
	assert.equal(replacement.service.mailbox.value!.requests.length, 0);
	const next = broker.execute({ ...command(), commandId: "new-user-command" }, context);
	const request = replacement.service.mailbox.value!.requests[0]!;
	assert.equal(request.type, "execute");
	await replacement.service.respond(
		{
			requestId: request.requestId,
			generation: replacement.generation,
			type: "result",
			result: {
				commandId: "new-user-command",
				status: "rejected",
				error: { code: "save_rejected", message: "Studio declined this edit" },
			},
		},
		context,
	);
	assert.deepEqual(await next, {
		commandId: "new-user-command",
		status: "rejected",
		error: { code: "save_rejected", message: "Studio declined this edit" },
	});
});

test("Stop releases its mailbox request and allows a later command", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	const cancellation = withCancel(context);
	const pending = broker.execute(command(), cancellation.context);
	const stoppedRequest = a.service.mailbox.value!.requests[0]!;
	cancellation.cancel(new Error("Stopped"));
	await assert.rejects(pending, /Stopped/);
	assert.equal(a.service.mailbox.value!.requests.length, 0);
	await a.service.respond(
		{ requestId: stoppedRequest.requestId, generation: a.generation, type: "result", result: saved() },
		context,
	);
	assert.equal(a.service.mailbox.value!.requests.length, 0);

	const next = broker.execute({ ...command(), commandId: "next" }, context);
	const request = a.service.mailbox.value!.requests[0]!;
	await a.service.respond(
		{
			requestId: request.requestId,
			generation: a.generation,
			type: "result",
			result: { ...saved(), commandId: "next" },
		},
		context,
	);
	assert.equal((await next).status, "saved");
});

test("selection before the first snapshot stays ready and only an explicit read requests context", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const connection = broker.attach();
	const binding = { tabId: "tab-a", designId: "design-a" };
	const { generation } = await connection.service.register(
		{ ...binding, label: "Studio", contractVersion: 2 },
		context,
	);
	await connection.service.ready(generation, context);
	await connection.service.publishSelection(
		{ generation, sequence: 5, selectedObjectIds: ["chair-instance"] },
		context,
	);
	assert.equal(broker.getState(binding).phase, "ready");
	assert.equal(connection.service.mailbox.value!.requests.length, 0);
	const read = broker.freshContext(binding, context);
	const request = connection.service.mailbox.value!.requests[0]!;
	assert.equal(request.type, "context");
	await connection.service.respond(
		{ requestId: request.requestId, generation, type: "context", context: { generation, sequence: 1, snapshot } },
		context,
	);
	assert.deepEqual((await read).selectedObjectIds, ["chair-instance"]);
});

test("Studio can select a newly added object before publishing its updated inventory", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	await a.service.publishSelection(
		{ generation: a.generation, sequence: 2, selectedObjectIds: ["new-object"] },
		context,
	);
	assert.equal(broker.getState(a.binding).phase, "ready");
	assert.deepEqual(broker.getState(a.binding).snapshot?.selectedObjectIds, ["new-object"]);
	assert.equal(a.service.mailbox.value!.requests.length, 0);
});
