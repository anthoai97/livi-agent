import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it } from "vitest";
import type { StudioCommandResult, StudioSnapshot } from "../src/services/studio.ts";
import { StudioBroker } from "../src/studio-broker.ts";
import { readStudioJournal, restoreStudioJournal, StudioJournal } from "../src/studio-journal.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const session = await repo.create({}, context);
	const journal = new StudioJournal(session);
	const binding = { designId: "simulated-design", tabId: "simulated-tab" };
	const snapshot: StudioSnapshot = {
		designId: binding.designId,
		revision: "1",
		geometry: {
			floor: [
				[0, 0],
				[4, 0],
				[4, 4],
			],
			height: 3,
		},
		openings: [],
		selectedObjectIds: ["chair"],
		objects: [
			{
				id: "chair",
				name: "Simulated chair",
				category: "chair",
				dimensions: [1, 1, 1],
				position: [1, 1, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			},
		],
	};
	await journal.setBinding(binding);
	await journal.admit("operation");
	await journal.plan({ operationId: "operation", turnId: "turn", binding, snapshot, unavailable: null });
	const commandId = JSON.stringify([session.metadata.id, "invocation"]);
	const before = {
		position: snapshot.objects[0]!.position,
		rotation: snapshot.objects[0]!.rotation,
		scale: snapshot.objects[0]!.scale,
	};
	const input = {
		command: {
			commandId,
			conversationId: session.metadata.id,
			binding,
			expectedRevision: "1",
			objectId: "chair",
			action: { type: "move" as const, position: [2, 1, 0] as [number, number, number] },
		},
		operationId: "operation",
		turnId: "turn",
		invocationId: "invocation",
		observedBefore: before,
	};
	const savedSnapshot = structuredClone(snapshot);
	savedSnapshot.revision = "2";
	savedSnapshot.objects[0]!.position = [2, 1, 0];
	const saved: Extract<StudioCommandResult, { status: "saved" }> = {
		commandId,
		status: "saved",
		revision: "2",
		snapshot: savedSnapshot,
		before,
		after: { ...before, position: [2, 1, 0] },
	};
	return { repo, session, journal, input, saved, binding };
}

it("atomically settles identical concurrent acknowledgements and never replaces a committed result", async () => {
	const { journal, input, saved } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	const settled = await Promise.all([journal.settle(saved), journal.settle(structuredClone(saved))]);
	expect(settled[0]).toEqual(settled[1]);
	expect(settled[0]?.state).toBe("committed");
	await expect(
		journal.settle({
			commandId: saved.commandId,
			status: "rejected",
			error: { code: "save_rejected", message: "Conflicting result" },
		}),
	).rejects.toThrow("Conflicting");
	expect((await journal.get(saved.commandId))?.result).toEqual(saved);
});

it.each(["changed_rotation", "nonfinite", "wrong_action", "wrong_design", "identity", "unrelated_object"])(
	"keeps invalid %s saved evidence unknown",
	async (kind) => {
		const { journal, input, saved } = await fixture();
		await journal.prepare(input);
		await journal.dispatch(saved.commandId, new AbortController().signal);
		if (kind === "changed_rotation") saved.after!.rotation = [0, 0, 1];
		if (kind === "nonfinite") saved.before.position = [NaN, 1, 0];
		if (kind === "wrong_action") saved.after!.position = [3, 1, 0];
		if (kind === "wrong_design") saved.snapshot.designId = "another-design";
		if (kind === "identity") saved.snapshot.objects[0]!.name = "Replacement object";
		if (kind === "unrelated_object") saved.snapshot.objects.push({ ...saved.snapshot.objects[0]!, id: "extra" });
		await expect(journal.settle(saved)).rejects.toThrow();
		expect((await journal.get(saved.commandId))?.state).toBe("outcome_unknown");
	},
);

it("refuses unpublished results and leaves cancellation terminal across restore", async () => {
	const { journal, input, saved, session, repo } = await fixture();
	await journal.prepare(input);
	await expect(journal.settle(saved)).rejects.toThrow("unpublished");
	const cancel = new AbortController();
	cancel.abort();
	expect((await journal.dispatch(saved.commandId, cancel.signal)).state).toBe("cancelled_before_send");
	await session.close(context);
	const reopened = await repo.open(session.metadata, context);
	const broker = new StudioBroker();
	cleanup.push(() => broker.close());
	const restored = await restoreStudioJournal(reopened, broker);
	expect((await restored.get(saved.commandId))?.state).toBe("cancelled_before_send");
	expect(broker.getState(input.command.binding).busy).toBe(false);
});

it("inventories and fences uncertain commands in an unopened conversation without creating a lane", async () => {
	const { journal, input, saved, session, repo } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	await session.close(context);
	const reopened = await repo.open(session.metadata, context);
	const broker = new StudioBroker();
	cleanup.push(() => broker.close());
	await restoreStudioJournal(reopened, broker);
	expect(await readStudioJournal(reopened)).toMatchObject({
		binding: input.command.binding,
		records: [{ state: "outcome_unknown" }],
	});
	expect(broker.getState(input.command.binding).busy).toBe(true);
	expect(await reopened.branch("main", context)).toBeUndefined();
	expect(() => broker.claim("another-conversation", input.command.binding)).toThrow("Another conversation");
});

it("does not prepare missing turn evidence or alter the immutable payload on replay", async () => {
	const { journal, input } = await fixture();
	await expect(journal.prepare({ ...input, turnId: "missing" })).rejects.toThrow("planning evidence");
	await journal.prepare(input);
	await expect(journal.prepare({ ...input, command: { ...input.command, objectId: "other" } })).rejects.toThrow(
		"identity conflict",
	);
	expect((await journal.records())[0]?.command).toEqual(input.command);
});
