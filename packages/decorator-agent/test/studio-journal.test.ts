import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioCommandResult, StudioSnapshot } from "../src/services/studio.ts";
import { StudioJournal } from "../src/studio-journal.ts";

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

it("stores Studio's supplied saved result without crossvalidating unrelated room changes", async () => {
	const { journal, input, saved, session, repo } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	saved.snapshot.geometry.height = 8;
	saved.snapshot.objects.push({ ...saved.snapshot.objects[0]!, id: "new-object", name: "New furniture" });
	saved.snapshot.objects[0]!.name = "Updated Studio label";
	const settled = await journal.settle(saved);
	expect(settled.state).toBe("committed");
	expect(settled.result).toEqual(saved);
	await session.close(context);
	const reopened = await repo.open(session.metadata, context);
	expect((await new StudioJournal(reopened).get(saved.commandId))?.result).toEqual(saved);
});

it("keeps unknown replies transient and preserves the supplied error", async () => {
	const { journal, input, saved, session, repo } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	const result: StudioCommandResult = {
		commandId: saved.commandId,
		status: "unknown",
		message: "Studio connection dropped after dispatch",
	};
	expect((await journal.settle(result)).result).toEqual(result);
	await session.close(context);
	const reopened = await repo.open(session.metadata, context);
	expect(await new StudioJournal(reopened).records()).toEqual([]);
});

it("reports Studio's saved result even when the optional undo history cannot persist", async () => {
	const { journal, input, saved, session } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	vi.spyOn(session, "setValue").mockRejectedValue(new Error("History storage unavailable"));
	expect(await journal.settle(saved)).toMatchObject({ state: "committed", result: saved });
	expect((await journal.get(saved.commandId))?.result).toEqual(saved);
	expect(await journal.mutationBlocked(input.operationId)).toBe(false);
});

it("discards finished request context and unknown results without removing saved history", async () => {
	const { journal, input, saved } = await fixture();
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	await journal.settle({ commandId: saved.commandId, status: "unknown", message: "No reply" });
	await journal.blockMutations(input.operationId);
	await journal.discardAdmission(input.operationId);
	expect(await journal.admission(input.operationId)).toBeUndefined();
	expect(await journal.planning(input.operationId, input.turnId)).toBeUndefined();
	expect(await journal.mutationBlocked(input.operationId)).toBe(false);
	expect(await journal.records()).toEqual([]);
	await journal.prepare(input);
	await journal.dispatch(saved.commandId, new AbortController().signal);
	await journal.settle(saved);
	await journal.discardAdmission(input.operationId);
	expect((await journal.get(saved.commandId))?.result).toEqual(saved);
});
