import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo, operationState, type Session } from "@earendil-works/pi-agent-core/harness/session";
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
				product: { catalogId: "catalog-chair", price: { amountMinor: 12999, currency: "USD" } },
			},
			{
				id: "chair-2",
				name: "Chair",
				category: "chair",
				dimensions: [1, 1, 1],
				position: [3, 2, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
				product: { catalogId: "catalog-chair", price: null },
			},
		],
		selectedObjectIds: ["chair-1"],
		budget: { amountMinor: 500000, currency: "USD" },
	};
}

async function adapter(broker: StudioBroker, stored: Session) {
	const connection = broker.attach();
	const binding = { designId: "simulated-room", tabId: "simulated-tab" };
	const { generation } = await connection.service.register(
		{ ...binding, label: "Simulated Studio", contractVersion: 2 },
		context,
	);
	const state = {
		session: stored,
		snapshot: room(),
		sequence: 0,
		commands: [] as StudioCommand[],
		results: new Map<string, StudioCommandResult>(),
		hold: false,
		holdContext: false,
		held: [] as StudioMailboxRequest[],
		errors: [] as unknown[],
	};
	const seen = new Set<string>();
	const respond = async (request: StudioMailboxRequest) => {
		if (request.type === "context") {
			if (state.holdContext) {
				state.held.push(request);
				return;
			}
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
		} else throw new Error("Unexpected Studio request");
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

async function fixture(onDebug?: (event: string, fields: Record<string, unknown>) => void) {
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
		onDebug,
	});
	cleanup.push(async () => {
		await broker.close();
		await runtime.close();
		expect(errors).toEqual([]);
	});
	await runtime.studio.service.bind(fake.binding, context);
	return { repo, stored, broker, fake, faux, models, runtime, errors };
}

async function prompt(runtime: DecoratorSession, message = "Move the selected chair") {
	const admitted = await runtime.controller.prompt({ message }, context);
	if (!admitted.accepted) throw new Error("Expected prompt admission");
	return admitted.operationId;
}

it("sends Gemini numeric-array schemas instead of unsupported tuple item arrays", () => {
	const declarations = convertTools(createStudioTools())![0]!.functionDeclarations;
	expect(declarations.find((tool) => tool.name === "get_room_context")?.parametersJsonSchema).toMatchObject({
		type: "object",
		properties: {},
		additionalProperties: false,
	});
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

it("refreshes a rejected stale move and recomputes from the new position in the same operation", async () => {
	const events: Record<string, unknown>[] = [];
	const { runtime, fake, faux, broker } = await fixture((event, fields) => events.push({ event, ...fields }));
	const fresh = vi.spyOn(broker, "freshContext");
	const prepare = vi.spyOn(runtime.studio, "prepare");
	fake.state.snapshot.selectedObjectIds = [];
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"revision":"1"');
			fake.state.snapshot.objects[0]!.position = [4, 2, 0];
			fake.state.snapshot.revision = "2";
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		(input) => {
			expect(JSON.stringify(input.messages)).toContain("stale_revision");
			return fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" });
		},
		(input) => {
			const result = input.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "get_room_context",
			);
			if (result?.role !== "toolResult" || result.content[0]?.type !== "text") throw new Error("Missing refresh");
			const planning = JSON.parse(result.content[0].text) as { operationId: string; snapshot: StudioSnapshot };
			expect(planning.snapshot.revision).toBe("2");
			expect(planning.snapshot.selectedObjectIds).toEqual([]);
			expect(input.systemPrompt).toContain('"position":[4,2,0]');
			// Initial generation, post-rejection generation, explicit refresh; no incidental fetch masks the handoff.
			expect(fresh).toHaveBeenCalledTimes(3);
			const object = planning.snapshot.objects.find((object) => object.id === "chair-1")!;
			return fauxAssistantMessage(
				fauxToolCall("move_object", {
					objectId: object.id,
					position: [object.position[0] + 1, object.position[1], object.position[2]],
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Moved one metre right"),
	]);
	const operationId = await prompt(runtime, "Move chair-1 one metre right");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands.map((command) => command.expectedRevision)).toEqual(["1", "2"]);
	expect(fake.state.snapshot.objects[0]?.position).toEqual([5, 2, 0]);
	expect(prepare.mock.calls.map(([record]) => record.operationId)).toEqual([operationId, operationId]);
	const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
	expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
	expect((await runtime.studio.journal.records())[0]?.state).toBe("committed");
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ event: "tool.result", operationId, status: "rejected" }),
			expect.objectContaining({
				event: "tool.error",
				operationId,
				errorCode: "stale_revision",
				mutationBlocked: false,
			}),
			expect.objectContaining({
				event: "context.ready",
				operationId,
				source: "refresh",
				revision: "2",
				objectCount: 2,
			}),
			expect.objectContaining({ event: "tool.result", operationId, status: "saved", revision: "3" }),
		]),
	);
});

it("does not rebase precomputed actions in the refresh batch", async () => {
	const { runtime, fake, faux } = await fixture();
	faux.setResponses([
		() => {
			fake.state.snapshot.objects[0]!.position = [4, 2, 0];
			fake.state.snapshot.revision = "2";
			return fauxAssistantMessage(
				[
					fauxToolCall("get_room_context", {}),
					fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }),
				],
				{ stopReason: "toolUse" },
			);
		},
		(input) => {
			expect(input.systemPrompt).toContain('"revision":"2"');
			expect(input.systemPrompt).toContain('"position":[4,2,0]');
			return fauxAssistantMessage("Replanning required");
		},
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.commands[0]?.expectedRevision).toBe("1");
	expect(fake.state.snapshot.objects[0]?.position).toEqual([4, 2, 0]);
});

it("refuses refresh after the conversation attachment changes", async () => {
	const { runtime, fake, faux, broker } = await fixture();
	const fresh = vi.spyOn(broker, "freshContext");
	faux.setResponses([
		async () => {
			await runtime.studio.service.bind({ designId: "different-room", tabId: "different-tab" }, context);
			return fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" });
		},
		(input) => {
			expect(JSON.stringify(input.messages)).toContain("wrong_binding");
			return fauxAssistantMessage("The attachment changed");
		},
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(fresh).toHaveBeenCalledTimes(1);
	expect(fake.state.commands).toEqual([]);
});

it("cancels an in-flight explicit refresh without sending the next batch action", async () => {
	const events: Record<string, unknown>[] = [];
	const { runtime, fake, faux } = await fixture((event, fields) => events.push({ event, ...fields }));
	faux.setResponses([
		() => {
			fake.state.holdContext = true;
			return fauxAssistantMessage(
				[
					fauxToolCall("get_room_context", {}),
					fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }),
				],
				{ stopReason: "toolUse" },
			);
		},
	]);
	const operationId = await prompt(runtime);
	await expect.poll(() => fake.state.held.length).toBe(1);
	await runtime.controller.requestAbort(operationId, context);
	await runtime.lane.waitForIdle(context);
	expect(await runtime.lane.getResult(operationId, context)).toMatchObject({ status: "aborted" });
	expect(fake.connection.service.mailbox.value!.requests).toEqual([]);
	expect(fake.state.commands).toEqual([]);
	expect(events).toEqual(
		expect.arrayContaining([expect.objectContaining({ event: "chat.aborted", operationId, status: "aborted" })]),
	);
});

it("moves, rotates, and reverses completed actions across reopen", async () => {
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

it("uses the room inventory for a named object when nothing is selected", async () => {
	const { runtime, fake, faux } = await fixture();
	fake.state.snapshot.selectedObjectIds = [];
	fake.state.snapshot.objects[0]!.name = "Sofa";
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"selectedObjectIds":[]');
			expect(input.systemPrompt).toContain('"name":"Sofa"');
			expect(input.systemPrompt).toContain('"id":"chair-1"');
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [1.5, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Moved the sofa 0.5 metres right"),
	]);
	await prompt(runtime, "Move the sofa 0.5 metres right");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.snapshot.objects[0]?.position).toEqual([1.5, 2, 0]);
	expect((await runtime.studio.journal.records())[0]?.state).toBe("committed");
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
	expect(await runtime.studio.journal.records()).toEqual([]);
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
	expect((await runtime.studio.journal.records()).map((record) => record.state)).toEqual(["committed"]);
	expect(JSON.stringify(await runtime.lane.findEntries({ order: "oldestFirst" }, context))).toContain(
		"Room changed since planning",
	);
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
		action: null,
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
			expect(input.tools?.map((tool) => tool.name)).toEqual([
				"move_object",
				"rotate_object",
				"remove_object",
				"get_room_context",
				"search_catalog",
				"get_product_details",
			]);
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

it("traces an invalid reversal and its blocked fallback without leaking model or room payloads", async () => {
	const events: Record<string, unknown>[] = [];
	const { runtime, fake, faux, stored } = await fixture((event, fields) => events.push({ event, ...fields }));
	fake.state.snapshot.objects[0]!.name = "private-room-object-marker";
	faux.setResponses([
		fauxAssistantMessage(
			[
				{ type: "thinking", thinking: "private-thinking-marker", thinkingSignature: "private-signature-marker" },
				fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("private-model-response-marker"),
	]);
	const message = "private-user-prompt-marker";
	const savedOperationId = await prompt(runtime, message);
	await runtime.lane.waitForIdle(context);
	const original = (await runtime.studio.journal.records())[0]!;
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("move_object", { objectId: "chair-2", originalCommandId: original.command.commandId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-2", position: [4, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Cannot reverse a different object"),
	]);
	const blockedOperationId = await prompt(runtime, "Reverse the other chair");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	const reversal = events.find((entry) => entry.event === "tool.error" && entry.errorCode === "invalid_target");
	expect(reversal).toMatchObject({
		sessionId: stored.metadata.id,
		operationId: blockedOperationId,
		turnId: expect.any(String),
		invocationId: expect.any(String),
		commandId: expect.any(String),
		toolName: "move_object",
		mutationBlocked: true,
		reason: "original_object_mismatch",
		requestedObjectId: "chair-2",
		originalObjectId: "chair-1",
		originalAction: "move",
		originalState: "committed",
		originalStatus: "saved",
		originalCommandId: original.command.commandId,
	});
	const correlation = {
		sessionId: stored.metadata.id,
		operationId: blockedOperationId,
		turnId: reversal!.turnId,
		invocationId: reversal!.invocationId,
		commandId: reversal!.commandId,
	};
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				event: "chat.accepted",
				operationId: savedOperationId,
				messageLength: message.length,
			}),
			expect.objectContaining({
				event: "tool.start",
				...correlation,
				toolName: "move_object",
				arguments: { objectId: "chair-2", originalCommandId: original.command.commandId },
			}),
			expect.objectContaining({
				event: "mutation.blocked",
				...correlation,
				cause: "reversal_failed",
				errorCode: "invalid_target",
				mutationBlocked: true,
			}),
			expect.objectContaining({
				event: "context.ready",
				operationId: blockedOperationId,
				source: "refresh",
				revision: "2",
				objectCount: 2,
			}),
			expect.objectContaining({
				event: "tool.result",
				toolName: "get_room_context",
				operationId: blockedOperationId,
				mutationBlocked: true,
			}),
		]),
	);
	const fallback = events.find((entry) => entry.event === "tool.error" && entry.errorCode === "mutation_blocked");
	expect(fallback).toMatchObject({ operationId: blockedOperationId, toolName: "move_object", mutationBlocked: true });
	expect(fallback!.invocationId).not.toBe(reversal!.invocationId);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-2", position: [4, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Saved the new request"),
	]);
	const nextOperationId = await prompt(runtime, "Move chair-2 now");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(2);
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				event: "tool.result",
				operationId: nextOperationId,
				status: "saved",
				state: "committed",
				revision: "3",
			}),
			expect.objectContaining({ event: "chat.finished", operationId: blockedOperationId, status: "completed" }),
		]),
	);
	const serialized = JSON.stringify(events);
	for (const privateValue of [
		message,
		"private-room-object-marker",
		"private-thinking-marker",
		"private-signature-marker",
		"private-model-response-marker",
		'"geometry"',
		'"snapshot"',
		'"systemPrompt"',
	])
		expect(serialized).not.toContain(privateValue);
});

it("logs a provider failure code without its raw error text", async () => {
	const events: Record<string, unknown>[] = [];
	const { runtime, faux, fake, stored } = await fixture((event, fields) => events.push({ event, ...fields }));
	const secret = "private-provider-error-marker";
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: secret })]);
	const operationId = await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				event: "chat.finished",
				sessionId: stored.metadata.id,
				operationId,
				status: "failed",
				errorCode: "assistant_error",
			}),
		]),
	);
	expect(JSON.stringify(events)).not.toContain(secret);
	expect(fake.state.commands).toEqual([]);
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
		fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" }),
		(input) => {
			expect(input.systemPrompt).toContain("Current request mutation block: true");
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [1, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("The object changed"),
	]);
	await prompt(runtime, "Move it back");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(fake.state.snapshot.objects[0]?.position).toEqual([2, 2, 0]);
});

it("reports a lost reply once, refuses a model retry, and permits the next explicit user edit", async () => {
	const events: Record<string, unknown>[] = [];
	const { runtime, fake, faux } = await fixture((event, fields) => events.push({ event, ...fields }));
	fake.state.hold = true;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
		(input) => {
			const results = input.messages.filter((message) => message.role === "toolResult");
			expect(JSON.stringify(results)).toContain("No result");
			return fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" });
		},
		(input) => {
			expect(input.systemPrompt).toContain("Current request mutation block: true");
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("No result received. Check Studio before another request."),
	]);
	await prompt(runtime);
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(1);
	expect(await runtime.studio.journal.records()).toEqual([]);
	await runtime.studio.service.bind(null, context);
	await runtime.studio.service.bind(fake.binding, context);
	fake.state.hold = false;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Studio saved the rotation"),
	]);
	await prompt(runtime, "Rotate the chair now");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands.map((command) => command.action.type)).toEqual(["move", "rotate"]);
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ event: "tool.result", status: "unknown" }),
			expect.objectContaining({ event: "tool.error", errorCode: "outcome_unknown", mutationBlocked: true }),
		]),
	);
});

it("Stop after dispatch leaves no room lock and a new user request can save", async () => {
	const { runtime, fake, faux } = await fixture();
	fake.state.hold = true;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
	]);
	const operationId = await prompt(runtime);
	await expect.poll(() => fake.state.held.length).toBe(1);
	await runtime.controller.requestAbort(operationId, context);
	await runtime.lane.waitForIdle(context);
	expect(await runtime.lane.getResult(operationId, context)).toMatchObject({ status: "aborted" });
	expect(fake.connection.service.mailbox.value!.requests).toEqual([]);
	fake.state.hold = false;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Saved"),
	]);
	await prompt(runtime, "Rotate it");
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(2);
});

it("never replays an old safe pending effect after restart, including model retry; a new prompt still works", async () => {
	const { runtime, fake, faux, repo, stored, broker, models } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await runtime.harness.setTools(
		createStudioTools().map((tool) => ({
			...tool,
			replay: "safe" as const,
			execute: async (...args: Parameters<typeof tool.execute>) => {
				const result = await tool.execute(...args);
				entered.resolve();
				await release.promise;
				return result;
			},
		})),
		context,
	);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
	]);
	const operationId = await prompt(runtime);
	await entered.promise;
	const pending = await stored.getValue(operationState(operationId), context);
	expect(pending?.value).toMatchObject({
		at: "tools",
		batch: { calls: [{ status: "effect_pending", replay: "safe" }] },
	});
	await runtime.close();
	release.resolve();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The interrupted edit was not resent"),
	]);
	const reopened = await repo.open(stored.metadata, context);
	const recovered = await DecoratorSession.create({ session: reopened, studio: broker, models });
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	const recoveredTools = await recovered.harness.getTools(context);
	expect(
		recoveredTools
			.filter((tool) => ["move_object", "rotate_object", "remove_object", "get_room_context"].includes(tool.name))
			.every((tool) => tool.replay === "never"),
	).toBe(true);
	expect(
		recoveredTools
			.filter((tool) => tool.name === "search_catalog" || tool.name === "get_product_details")
			.every((tool) => tool.replay === "safe"),
	).toBe(true);
	expect(fake.state.commands).toHaveLength(1);
	const entries = await recovered.lane.findEntries({ order: "oldestFirst" }, context);
	expect(
		entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError),
	).toBe(true);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-1", rotation: [0, 0, 1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("New request saved"),
	]);
	await prompt(recovered, "Rotate the chair");
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toHaveLength(2);
});

it("includes product, price, and budget facts in room planning without treating unknown as zero", async () => {
	const { runtime, faux } = await fixture();
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"catalogId":"catalog-chair"');
			expect(input.systemPrompt).toContain('"amountMinor":12999');
			expect(input.systemPrompt).toContain('"amountMinor":500000');
			expect(input.systemPrompt).toContain('"price":null');
			expect(input.systemPrompt).not.toMatch(/"price":0\b/);
			expect(input.systemPrompt).not.toMatch(/"budget":0\b/);
			return fauxAssistantMessage("The priced chair is 129.99");
		},
	]);
	await prompt(runtime, "What is in the room?");
	await runtime.lane.waitForIdle(context);
});

it("does not retarget an admitted selection after the conversation attachment changes", async () => {
	const { runtime, fake, faux } = await fixture();
	const action = { type: "replace_asset" as const, selectedProductId: "sofa-123", targetObjectId: "chair-1" };
	faux.setResponses([
		async (input) => {
			expect(input.systemPrompt).toContain('"type":"replace_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"sofa-123"');
			expect(input.systemPrompt).toContain('"targetObjectId":"chair-1"');
			await runtime.studio.service.bind({ designId: "different-room", tabId: "different-tab" }, context);
			return fauxAssistantMessage(fauxToolCall("get_room_context", {}), { stopReason: "toolUse" });
		},
		(input) => {
			expect(JSON.stringify(input.messages)).toContain("wrong_binding");
			expect(input.systemPrompt).toContain('"type":"replace_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"sofa-123"');
			expect(input.systemPrompt).toContain('"targetObjectId":"chair-1"');
			return fauxAssistantMessage("The attachment changed");
		},
	]);
	expect(await runtime.controller.prompt({ message: "Replace this sofa", action }, context)).toMatchObject({
		accepted: true,
	});
	await runtime.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
});

it("exposes a recovered selection without replaying room mutations", async () => {
	const { runtime, repo, stored, broker, fake, faux, models } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const action = { type: "add_asset" as const, selectedProductId: "lamp-1", quantity: 2 };
	faux.setResponses([
		async (input) => {
			expect(input.systemPrompt).toContain('"type":"add_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"lamp-1"');
			expect(input.systemPrompt).toContain('"quantity":2');
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("Interrupted");
		},
	]);
	const admitted = await runtime.controller.prompt({ message: "Add two lamps", action }, context);
	if (!admitted.accepted) throw new Error("Expected admission");
	await entered.promise;
	await runtime.close();
	release.resolve();
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"type":"add_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"lamp-1"');
			expect(input.systemPrompt).toContain('"quantity":2');
			expect(input.systemPrompt).toContain("Current request mutation block: true");
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("The interrupted request cannot edit the room"),
	]);
	const recovered = await DecoratorSession.create({
		session: await repo.open(stored.metadata, context),
		models,
		studio: broker,
	});
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
	expect(JSON.stringify(await recovered.lane.findEntries({ order: "oldestFirst" }, context))).toContain(
		"mutation_blocked",
	);
});

it("keeps the pinned selection after a failed open drive so recovery can resume it", async () => {
	const { runtime, repo, stored, broker, fake, faux, models, errors } = await fixture();
	const action = { type: "replace_asset" as const, selectedProductId: "sofa-123", targetObjectId: "chair-1" };
	vi.spyOn(runtime.lane, "drive").mockRejectedValueOnce(new Error("Simulated drive failure"));
	const admitted = await runtime.controller.prompt({ message: "Replace this sofa", action }, context);
	if (!admitted.accepted) throw new Error("Expected admission");
	await expect.poll(() => errors.map((error) => error.message)).toEqual(["Simulated drive failure"]);
	expect((await runtime.lane.inspectExecution(context)).current?.id).toBe(admitted.operationId);
	expect(await runtime.lane.getResult(admitted.operationId, context)).toBeUndefined();
	expect(await runtime.studio.journal.admission(admitted.operationId)).toEqual({
		value: fake.binding,
		action,
		originalQuery: "Replace this sofa",
	});
	await runtime.studio.service.bind({ designId: "different-room", tabId: "different-tab" }, context);
	expect(await runtime.studio.journal.admission(admitted.operationId)).toEqual({
		value: fake.binding,
		action,
		originalQuery: "Replace this sofa",
	});
	errors.length = 0;
	await runtime.close();
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"type":"replace_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"sofa-123"');
			expect(input.systemPrompt).toContain('"targetObjectId":"chair-1"');
			expect(input.systemPrompt).toContain('"designId":"simulated-room"');
			expect(input.systemPrompt).toContain('"tabId":"simulated-tab"');
			expect(input.systemPrompt).toContain("Current request mutation block: true");
			return fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-1", position: [2, 2, 0] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("The interrupted request cannot edit the room"),
	]);
	const recovered = await DecoratorSession.create({
		session: await repo.open(stored.metadata, context),
		models,
		studio: broker,
	});
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	expect(fake.state.commands).toEqual([]);
	expect(JSON.stringify(await recovered.lane.findEntries({ order: "oldestFirst" }, context))).toContain(
		"mutation_blocked",
	);
});
