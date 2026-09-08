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
		{ tabId, designId, label: tabId, contractVersion: 1 },
		context,
	);
	await attachment.service.ready(generation, context);
	const request = attachment.service.mailbox.value!.requests[0]!;
	await attachment.service.respond(
		{
			requestId: request.requestId,
			generation,
			type: "context",
			context: { generation, sequence: 0, snapshot: { ...structuredClone(snapshot), designId } },
		},
		context,
	);
	await new Promise((done) => setImmediate(done));
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

test("private mailboxes, generation authority, design ownership, and late context ordering", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	const b = await adapter(broker, "tab-b", "design-b");
	broker.claim("chat-a", a.binding);
	assert.throws(() => broker.claim("other-chat", { ...a.binding, tabId: "another-tab" }), /Another conversation/);
	let durable = false;
	broker.track(command(), async () => {
		durable = true;
		broker.release("command-a");
	});
	const pending = broker.execute(command(), context);
	const request = a.service.mailbox.value!.requests[0]!;
	assert.equal(request.type, "execute");
	assert.equal(b.service.mailbox.value!.requests.length, 0);
	await assert.rejects(
		b.service.respond(
			{ requestId: request.requestId, generation: b.generation, type: "result", result: saved() },
			context,
		),
		/this connection/,
	);
	assert.equal(durable, false);
	const newer = { ...structuredClone(snapshot), revision: "saved-3", selectedObjectIds: [] };
	await a.service.publishContext({ generation: a.generation, sequence: 3, snapshot: newer }, context);
	await a.service.respond(
		{
			requestId: request.requestId,
			generation: a.generation,
			type: "result",
			result: saved(),
			context: { generation: a.generation, sequence: 1, snapshot: snapshot },
		},
		context,
	);
	assert.equal((await pending).status, "saved");
	await a.service.respond(
		{
			requestId: request.requestId,
			generation: a.generation,
			type: "result",
			result: saved(),
			context: { generation: a.generation, sequence: 1, snapshot: snapshot },
		},
		context,
	);
	await assert.rejects(
		a.service.respond(
			{
				requestId: request.requestId,
				generation: a.generation,
				type: "result",
				result: { commandId: "command-a", status: "unknown", message: "conflicting duplicate" },
			},
			context,
		),
		/Conflicting duplicate/,
	);

	assert.equal(durable, true);
	assert.equal(broker.getState(a.binding).snapshot?.revision, "saved-3");
	assert.deepEqual(broker.getState(a.binding).snapshot?.selectedObjectIds, []);
	const duplicate = broker.attach();
	await assert.rejects(
		duplicate.service.register({ ...a.binding, label: "duplicate", contractVersion: 1 }, context),
		/active connection/,
	);
	a.release();
	const replacement = await adapter(broker);
	a.release();
	assert.equal(broker.getState(replacement.binding).phase, "ready");
	await assert.rejects(
		a.service.publishContext({ generation: a.generation, sequence: 100, snapshot }, context),
		/Retired/,
	);
});

test("cancelled and timed out mutation waiters retain durable late result callbacks", async (t) => {
	const broker = new StudioBroker({ timeoutMs: 30 });
	t.after(() => broker.close());
	const a = await adapter(broker);
	broker.claim("chat-a", a.binding);
	let writes = 0;
	broker.track(command(), async () => {
		writes++;
		broker.release("command-a");
	});
	const cancellation = withCancel(context);
	const pending = broker.execute(command(), cancellation.context);
	const request = a.service.mailbox.value!.requests[0]!;
	cancellation.cancel(new Error("Stopped"));
	await assert.rejects(pending, /Stopped/);
	await new Promise((done) => setTimeout(done, 45));
	assert.equal(broker.getState(a.binding).busy, true);
	await a.service.respond(
		{ requestId: request.requestId, generation: a.generation, type: "result", result: saved() },
		context,
	);
	assert.equal(writes, 1);
	assert.equal(broker.getState(a.binding).busy, false);
});

test("reconnect requires saved context and durable status before a design becomes ready", async (t) => {
	const broker = new StudioBroker();
	t.after(() => broker.close());
	const a = await adapter(broker);
	broker.claim("chat-a", a.binding);
	let settled = false;
	broker.track(command(), async (result) => {
		if (result.status === "saved") {
			settled = true;
			broker.release(result.commandId);
		}
	});
	a.release();
	const fresh = broker.attach();
	const { generation } = await fresh.service.register(
		{ ...a.binding, label: "Reconnected", contractVersion: 1 },
		context,
	);
	await fresh.service.ready(generation, context);
	const read = fresh.service.mailbox.value!.requests[0]!;
	assert.equal(read.type, "context");
	assert.equal(broker.getState(a.binding).phase, "reconciling");
	await fresh.service.respond(
		{ requestId: read.requestId, generation, type: "context", context: { generation, sequence: 0, snapshot } },
		context,
	);
	await new Promise((done) => setImmediate(done));
	const status = fresh.service.mailbox.value!.requests[0]!;
	assert.equal(status.type, "status");
	await fresh.service.respond({ requestId: status.requestId, generation, type: "result", result: saved() }, context);
	await new Promise((done) => setImmediate(done));
	assert.equal(settled, true);
	assert.equal(broker.getState(a.binding).phase, "ready");
});
