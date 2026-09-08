import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { convertTools } from "@earendil-works/pi-ai/api/google-shared";
import { afterEach, expect, it, vi } from "vitest";
import { DecoratorSession } from "../src/decorator-session.ts";
import type {
	StudioCommand,
	StudioCommandResult,
	StudioMailboxRequest,
	StudioSnapshot,
} from "../src/services/studio.ts";
import { StudioBroker } from "../src/studio-broker.ts";
import { StudioJournal } from "../src/studio-journal.ts";
import { createStudioTools } from "../src/studio-tools.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

/** Explicitly simulated room data; no database export or real Studio save is claimed. */
function room(): StudioSnapshot {
	return {
		designId: "simulated-room",
		revision: "1",
		geometry: {
			floor: [
				[0, 0],
				[5, 0],
				[5, 5],
				[0, 5],
			],
			height: 3,
		},
		openings: [],
		objects: [
			{
				id: "chair-1",
				name: "Chair",
				category: "chair",
				dimensions: [1, 1, 1],
				position: [1, 2, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			},
			{
				id: "chair-2",
				name: "Chair",
				category: "chair",
				dimensions: [1, 1, 1],
				position: [3, 2, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
			},
		],
		selectedObjectIds: ["chair-1"],
	};
}

async function adapter(broker: StudioBroker, stored: Session) {
	const connection = broker.attach();
	const binding = { designId: "simulated-room", tabId: "simulated-tab" };
	const { generation } = await connection.service.register(
		{ ...binding, label: "Simulated Studio", contractVersion: 1 },
		context,
	);
	const state = {
		session: stored,
		snapshot: room(),
		sequence: 0,
		commands: [] as StudioCommand[],
		results: new Map<string, StudioCommandResult>(),
		hold: false,
		held: [] as StudioMailboxRequest[],
		errors: [] as unknown[],
	};
	const seen = new Set<string>();
	const respond = async (request: StudioMailboxRequest) => {
		if (request.type === "context") {
			await connection.service.respond(
				{
					requestId: request.requestId,
					generation,
					type: "context",
					context: { generation, sequence: ++state.sequence, snapshot: structuredClone(state.snapshot) },
				},
				context,
			);
			return;
		}
		let result: StudioCommandResult;
		if (request.type === "execute") {
			const command = request.command;
			expect((await new StudioJournal(state.session).get(command.commandId))?.state).toBe("outcome_unknown");
			state.commands.push(command);
			const existing = state.results.get(command.commandId);
			if (existing) result = existing;
			else if (command.expectedRevision !== state.snapshot.revision)
				result = {
					commandId: command.commandId,
					status: "rejected",
					error: { code: "stale_revision", message: "Room changed since planning" },
				};
			else {
				const object = state.snapshot.objects.find((object) => object.id === command.objectId)!;
				const before = {
					position: [...object.position] as [number, number, number],
					rotation: [...object.rotation] as [number, number, number],
					scale: [...object.scale] as [number, number, number],
				};
				if (command.action.type === "move") object.position = command.action.position;
				if (command.action.type === "rotate") object.rotation = command.action.rotation;
				if (command.action.type === "remove") {
					state.snapshot.objects = state.snapshot.objects.filter((object) => object.id !== command.objectId);
					state.snapshot.selectedObjectIds = state.snapshot.selectedObjectIds.filter(
						(id) => id !== command.objectId,
					);
				}
				state.snapshot.revision = String(Number(state.snapshot.revision) + 1);
				const after =
					command.action.type === "remove"
						? null
						: { position: object.position, rotation: object.rotation, scale: object.scale };
				result = {
					commandId: command.commandId,
					status: "saved",
					revision: state.snapshot.revision,
					snapshot: structuredClone(state.snapshot),
					before,
					after: structuredClone(after),
				};
			}
			state.results.set(command.commandId, result);
			if (state.hold) {
				state.held.push(request);
				return;
			}
		} else
			result = state.results.get(request.commandId) ?? {
				commandId: request.commandId,
				status: "unknown",
				message: "No authoritative saved evidence",
			};
		await connection.service.respond({ requestId: request.requestId, generation, type: "result", result }, context);
	};
	const unsubscribe = connection.service.mailbox.subscribe((mailbox) => {
		for (const request of mailbox.requests)
			if (!seen.has(request.requestId)) {
				seen.add(request.requestId);
				void respond(request).catch((error: unknown) => state.errors.push(error));
			}
	});
	cleanup.push(() => {
		unsubscribe();
		connection.release();
		expect(state.errors).toEqual([]);
	});
	await connection.service.ready(generation, context);
	await expect.poll(() => broker.getState(binding).phase).toBe("ready");
	return {
		binding,
		state,
		connection,
		generation,
		async publish() {
			await connection.service.publishContext(
				{ generation, sequence: ++state.sequence, snapshot: structuredClone(state.snapshot) },
				context,
			);
		},
		async releaseResult() {
			for (const request of state.held.splice(0)) {
				if (request.type !== "execute") throw new Error("Expected execute");
				await connection.service.respond(
					{
						requestId: request.requestId,
						generation,
						type: "result",
						result: state.results.get(request.command.commandId)!,
					},
					context,
				);
			}
		},
	};
}

async function fixture() {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const stored = await repo.create({}, context);
	const broker = new StudioBroker({ timeoutMs: 500 });
	const fake = await adapter(broker, stored);
	const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.5-flash-lite" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const errors: Error[] = [];
	const runtime = await DecoratorSession.create({
		session: stored,
		models,
		studio: broker,
		onError: (error) => errors.push(error),
	});
	cleanup.push(async () => {
		await broker.close();
		await runtime.close();
		expect(errors).toEqual([]);
	});
	await runtime.studio.service.bind(fake.binding, context);
	return { repo, stored, broker, fake, faux, models, runtime };
}

async function prompt(runtime: DecoratorSession, message = "Move the selected chair") {
	const admitted = await runtime.controller.prompt({ message }, context);
	if (!admitted.accepted) throw new Error("Expected prompt admission");
	return admitted.operationId;
}

it("sends Gemini numeric-array schemas instead of unsupported tuple item arrays", () => {
	const declarations = convertTools(createStudioTools())![0]!.functionDeclarations;
	for (const [index, field] of [
		[0, "position"],
		[1, "rotation"],
	] as const) {
		expect(declarations[index]?.parametersJsonSchema).toMatchObject({
			type: "object",
			properties: { [field]: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } },
		});
	}
});

it("retains the original planning revision and selection while the model waits, then refreshes at the next generation", async () => {
	const { runtime, fake, faux } = await fixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		async (input) => {
			expect(input.systemPrompt).toContain('"revision":"1"');
			started.resolve();
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		(input) => {
			expect(input.systemPrompt).toContain('"revision":"2"');
			expect(input.systemPrompt).toContain('"selectedObjectIds":["chair-2"]');
			return fauxAssistantMessage("The room changed; please confirm the new position.");
		},
	]);
	const operationId = await prompt(runtime);
	await started.promise;
	fake.state.snapshot.revision = "2";
	fake.state.snapshot.selectedObjectIds = ["chair-2"];
	await fake.publish();
	release.resolve();
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.commands[0]).toMatchObject({ expectedRevision: "1", objectId: "chair-1" });
	expect(fake.state.snapshot.objects[0]?.position).toEqual([1, 2, 0]);
	expect((await runtime.studio.journal.records())[0]).toMatchObject({ operationId, state: "rejected" });
});

it("moves, rotates, reverses across reopen, and never repeats a committed invocation", async () => {
	const { runtime, repo, stored, broker, fake, faux, models } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Moved"),
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Rotated"),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	await prompt(runtime, "Rotate it");
	await runtime.lane.waitForIdle(context);
	const records = await runtime.studio.journal.records();
	const rotation = records.find((record) => record.command.action.type === "rotate")!;
	const move = records.find((record) => record.command.action.type === "move")!;
	expect(fake.state.snapshot.objects[1]).toEqual(room().objects[1]);
	await runtime.close();
	const reopened = await repo.open(stored.metadata, context);
	fake.state.session = reopened;
	const recovered = await DecoratorSession.create({ session: reopened, models, studio: broker });
	cleanup.push(() => recovered.close());
	const tool = createStudioTools().find((tool) => tool.name === "move_object")!;
	await tool.execute(
		"different-provider-id",
		{ objectId: "chair-1", position: [99, 99, 0] },
		() => {},
		{ studio: recovered.studio, planning: undefined },
		{
			invocationId: move.invocationId,
			operationId: move.operationId,
			turnId: move.turnId,
			getMemo: async () => undefined,
			setMemo: async () => {},
		},
		context,
	);
	expect(fake.state.commands).toHaveLength(2);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("rotate_object", { objectId: "chair-1", originalCommandId: rotation.command.commandId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Rotation reversed"),
		fauxAssistantMessage(
			fauxToolCall("move_object", { objectId: "chair-1", originalCommandId: move.command.commandId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Move reversed"),
	]);
	await prompt(recovered, "Undo the rotation");
	await recovered.lane.waitForIdle(context);
	await prompt(recovered, "Move it back");
	await recovered.lane.waitForIdle(context);
	expect(fake.state.snapshot.objects).toEqual(room().objects);
	expect(fake.state.commands[2]).toMatchObject({
		action: { type: "rotate", rotation: [0, 0, 0] },
		reversesCommandId: rotation.command.commandId,
	});
	expect(new Set(fake.state.commands.map((command) => command.commandId)).size).toBe(4);
});

it("keeps a late saved result durable and visible after Stop and blocks another mutation while unknown", async () => {
	const { runtime, fake, faux } = await fixture();
	fake.state.hold = true;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The previous save is still unknown"),
		fauxAssistantMessage("General advice remains available"),
	]);
	const operationId = await prompt(runtime);
	await expect.poll(() => fake.state.held.length).toBe(1);
	await runtime.controller.requestAbort(operationId, context);
	await runtime.lane.waitForIdle(context);
	expect((await runtime.studio.journal.records())[0]?.state).toBe("outcome_unknown");
	await expect(runtime.studio.service.bind(null, context)).rejects.toThrow("previous room action");
	await prompt(runtime, "Rotate it now");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(await runtime.studio.journal.records()).toHaveLength(1);
	await prompt(runtime, "Suggest lighting");
	await runtime.lane.waitForIdle(context);
	await fake.releaseResult();
	expect((await runtime.studio.journal.records())[0]?.state).toBe("committed");
	expect(runtime.studio.service.state.value?.actions[0]).toMatchObject({ state: "committed", message: "Saved" });
	expect(fake.state.commands).toHaveLength(1);
});

it("cancels a prepared command before mailbox exposure", async () => {
	const { runtime, faux, fake } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const execute = runtime.studio.execute.bind(runtime.studio);
	vi.spyOn(runtime.studio, "execute").mockImplementation(async (record, context) => {
		entered.resolve();
		await release.promise;
		return execute(record, context);
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
	]);
	const operationId = await prompt(runtime);
	await entered.promise;
	expect((await runtime.studio.journal.records())[0]?.state).toBe("prepared");
	await runtime.controller.requestAbort(operationId, context);
	release.resolve();
	await runtime.lane.waitForIdle(context);
	expect((await runtime.studio.journal.records())[0]?.state).toBe("cancelled_before_send");
	expect(fake.state.commands).toEqual([]);
	await runtime.studio.service.bind(null, context);
});

it("pins unattached admission even if a Studio is attached while the model waits", async () => {
	const { runtime, faux, fake } = await fixture();
	await runtime.studio.service.bind(null, context);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Submit a new room request"),
	]);
	const operationId = await prompt(runtime);
	await entered.promise;
	expect((await runtime.studio.journal.admission(operationId))?.value).toBeNull();
	await runtime.studio.service.bind(fake.binding, context);
	release.resolve();
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
});

it("serializes binding changes behind prompt admission and drops failed admission records", async () => {
	const { runtime, faux } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const accept = runtime.lane.accept.bind(runtime.lane);
	vi.spyOn(runtime.lane, "accept").mockImplementation(async (request, context) => {
		entered.resolve();
		await release.promise;
		return accept(request, context);
	});
	faux.setResponses([fauxAssistantMessage("Hello")]);
	const pending = prompt(runtime);
	await entered.promise;
	let changed = false;
	const binding = runtime.studio.service.bind(null, context).then(() => {
		changed = true;
	});
	await Promise.resolve();
	expect(changed).toBe(false);
	release.resolve();
	const operationId = await pending;
	await binding;
	expect((await runtime.studio.journal.admission(operationId))?.value).toMatchObject({ designId: "simulated-room" });
	await runtime.lane.waitForIdle(context);
	const before = await runtime.studio.journal.session.scanValues(
		{ kind: "value", namespace: "livi.studio.operation", key: "" },
		context,
	);
	expect(await runtime.controller.prompt({ message: "" }, context)).toMatchObject({ accepted: false });
	const after = await runtime.studio.journal.session.scanValues(
		{ kind: "value", namespace: "livi.studio.operation", key: "" },
		context,
	);
	expect(after).toEqual(before);
});

it("does not publish a delayed call after its conversation is detached", async () => {
	const { runtime, faux, fake } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Submit a new room request"),
	]);
	await prompt(runtime);
	await entered.promise;
	await runtime.studio.service.bind(null, context);
	release.resolve();
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
	expect(await runtime.studio.journal.records()).toEqual([]);
});

it("rejects a later call planned against the same revision instead of silently rebasing it", async () => {
	const { runtime, faux, fake } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }),
				fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Move saved; rotation needs replanning"),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands.map((command) => command.expectedRevision)).toEqual(["1", "1"]);
	expect((await runtime.studio.journal.records()).map((record) => record.state)).toEqual(["committed", "rejected"]);
	expect(fake.state.snapshot.objects[0]?.rotation).toEqual([0, 0, 0]);
});

it("rejects nonfinite direct execution arguments before preparing a command", async () => {
	const { runtime, fake } = await fixture();
	await runtime.studio.journal.admit("manual-operation");
	const planning = await runtime.studio.journal.plan({
		operationId: "manual-operation",
		turnId: "manual-turn",
		binding: fake.binding,
		snapshot: fake.state.snapshot,
		unavailable: null,
	});
	const move = createStudioTools()[0]!;
	await expect(
		move.execute(
			"call",
			{ objectId: "chair-1", position: [Infinity, 0, 0] },
			() => {},
			{ studio: runtime.studio, planning },
			{
				invocationId: "invocation",
				operationId: "manual-operation",
				turnId: "manual-turn",
				getMemo: async () => undefined,
				setMemo: async () => {},
			},
			context,
		),
	).rejects.toThrow("finite");
	expect(await runtime.studio.journal.records()).toEqual([]);
});

it("removes exactly one object and never reverses a removal", async () => {
	const { runtime, faux, fake } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("remove_object", { objectId: "chair-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Removed"),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	const removal = (await runtime.studio.journal.records())[0]!;
	expect(removal.state).toBe("committed");
	expect(fake.state.snapshot.objects).toEqual([room().objects[1]]);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("move_object", { objectId: "chair-1", originalCommandId: removal.command.commandId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Removal cannot be restored"),
	]);
	await prompt(runtime, "Undo that");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
});

it("replays a command committed before its harness tool result without a second effect", async () => {
	const { runtime, faux, fake, repo, stored, broker, models } = await fixture();
	const committed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settle = runtime.studio.journal.settle.bind(runtime.studio.journal);
	vi.spyOn(runtime.studio.journal, "settle").mockImplementation(async (result, context) => {
		const record = await settle(result, context);
		committed.resolve();
		await release.promise;
		return record;
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
	]);
	await prompt(runtime);
	await committed.promise;
	expect((await runtime.studio.journal.records())[0]?.state).toBe("committed");
	await runtime.close();
	release.resolve();
	await expect.poll(() => broker.getState(fake.binding).busy).toBe(false);
	fake.state.session = await repo.open(stored.metadata, context);
	faux.setResponses([fauxAssistantMessage("Saved move recovered")]);
	const recovered = await DecoratorSession.create({ session: fake.state.session, studio: broker, models });
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	const entries = await recovered.lane.findEntries({ order: "oldestFirst" }, context);
	expect(
		entries.some(
			(entry) => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError,
		),
	).toBe(true);
});

it("upgrades an old empty allowlist while keeping an admitted generation's captured configuration", async () => {
	const { runtime, repo, stored, models, faux, broker, fake } = await fixture();
	await runtime.lane.setActiveTools([], context);
	const entered = Promise.withResolvers<void>();
	const terminated = Promise.withResolvers<void>();
	vi.spyOn(runtime.studio, "context").mockImplementation(async () => {
		entered.resolve();
		await terminated.promise;
		throw new Error("Simulated process loss before the model request");
	});
	await prompt(runtime, "Old prompt");
	await entered.promise;
	await runtime.close();
	terminated.resolve();
	faux.setResponses([
		(input) => {
			expect(input.tools ?? []).toEqual([]);
			return fauxAssistantMessage("Recovered old chat");
		},
		(input) => {
			expect(input.tools?.map((tool) => tool.name)).toEqual(["move_object", "rotate_object", "remove_object"]);
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Moved"),
	]);
	fake.state.session = await repo.open(stored.metadata, context);
	const recovered = await DecoratorSession.create({ session: fake.state.session, models, studio: broker });
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	await prompt(recovered);
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
});

it.each([
	["move_object", { objectId: "Chair", position: [2, 2, 0] }],
	["move_object", { objectId: "chair-1", position: [2, 2, 0], originalCommandId: "bad" }],
	["rotate_object", { objectId: "chair-1", rotation: [1, 0, 0] }],
	["move_object", { objectId: "chair-1", position: [1, 2] }],
	["remove_object", { objectId: "chair-1", originalCommandId: "restore-removal" }],
])("rejects ambiguous or invalid %s arguments without mutation", async (name, args) => {
	const { runtime, fake, faux } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
		fauxAssistantMessage("Please clarify"),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
	expect(await runtime.studio.journal.records()).toEqual([]);
});

it("refuses reversal after a manual object change", async () => {
	const { runtime, fake, faux } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Moved"),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	const original = (await runtime.studio.journal.records())[0]!;
	fake.state.snapshot.objects[0]!.rotation = [0, 0, 0.5];
	fake.state.snapshot.revision = "3";
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("move_object", { objectId: "chair-1", originalCommandId: original.command.commandId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The object changed"),
	]);
	await prompt(runtime, "Move it back");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.snapshot.objects[0]?.position).toEqual([2, 2, 0]);
});

it("replays tools after an assistant was saved before the journal using the original durable planning snapshot", async () => {
	const { runtime, fake, faux, stored, repo, broker, models } = await fixture();
	const entered = Promise.withResolvers<void>();
	const terminated = Promise.withResolvers<void>();
	vi.spyOn(runtime.studio, "prepare").mockImplementation(async () => {
		entered.resolve();
		await terminated.promise;
		throw new Error("Simulated process loss");
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
	]);
	await prompt(runtime);
	await entered.promise;
	expect(await runtime.studio.journal.records()).toEqual([]);
	await runtime.close();
	terminated.resolve();
	fake.state.snapshot.revision = "2";
	fake.state.snapshot.objects[0]!.position = [4, 2, 0];
	faux.setResponses([fauxAssistantMessage("Room changed; replan required")]);
	fake.state.session = await repo.open(stored.metadata, context);
	const recovered = await DecoratorSession.create({ session: fake.state.session, models, studio: broker });
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.commands[0]?.expectedRevision).toBe("1");
	expect(fake.state.snapshot.objects[0]?.position).toEqual([4, 2, 0]);
	expect((await recovered.studio.journal.records())[0]?.state).toBe("rejected");
});
