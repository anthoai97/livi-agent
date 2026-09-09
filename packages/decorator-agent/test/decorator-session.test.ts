import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { DecoratorSession } from "../src/decorator-session.ts";

const cleanup: (() => Promise<void>)[] = [];
const toolNames = [
	"move_object",
	"rotate_object",
	"remove_object",
	"get_room_context",
	"search_catalog",
	"get_product_details",
];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const stored = await repo.create({}, context);
	const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.5-flash-lite" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await DecoratorSession.create({ session: stored, models });
	cleanup.push(() => runtime.close());
	return { repo, stored, faux, models, runtime };
}

it("returns durable admission while generation runs and survives caller cancellation", async () => {
	const { runtime, faux } = await fixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		async (input) => {
			expect(input.tools?.map((tool) => tool.name)).toEqual(toolNames);
			started.resolve();
			await release.promise;
			return fauxAssistantMessage("Use warm lighting.");
		},
	]);
	const caller = withCancel(context);
	const admitted = await runtime.controller.prompt({ message: "How can I make this room cozy?" }, caller.context);
	expect(admitted.accepted).toBe(true);
	await started.promise;
	caller.cancel(new Error("Browser disconnected"));
	expect(await runtime.controller.prompt({ message: "Duplicate" }, context)).toMatchObject({
		accepted: false,
		error: { code: "lane_busy" },
	});
	release.resolve();
	await runtime.lane.waitForIdle(context);
	const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
	expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
	expect(entries.at(-1)).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
	expect(await runtime.harness.getCompactionSettings(context)).toMatchObject({ enabled: false });
	expect(await runtime.harness.getResources(context)).toEqual({});
});

it("aborts a streaming operation and permits the next prompt", async () => {
	const { runtime, faux } = await fixture();
	const started = Promise.withResolvers<void>();
	faux.setResponses([
		async (_input, options) => {
			started.resolve();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		},
		fauxAssistantMessage("A fresh answer"),
	]);
	const admitted = await runtime.controller.prompt({ message: "First" }, context);
	if (!admitted.accepted) throw new Error("Expected admission");
	await started.promise;
	await runtime.controller.requestAbort(admitted.operationId, context);
	await runtime.lane.waitForIdle(context);
	expect(await runtime.lane.getResult(admitted.operationId, context)).toMatchObject({ status: "aborted" });
	expect(await runtime.controller.prompt({ message: "Next" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
});

it("restores an admitted operation exactly once without duplicating user input", async () => {
	const { runtime, repo, stored, models, faux } = await fixture();
	const accepted = await runtime.lane.accept({ kind: "prompt", prompt: "Recover this" }, context);
	expect(accepted.ok).toBe(true);
	await runtime.close();
	faux.setResponses([fauxAssistantMessage("Recovered")]);
	const reopened = await repo.open(stored.metadata, context);
	const recovered = await DecoratorSession.create({ session: reopened, models });
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	const entries = await recovered.lane.findEntries({ order: "oldestFirst" }, context);
	expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
	expect(faux.state.callCount).toBe(1);
	await recovered.close();
	const again = await DecoratorSession.create({ session: await repo.open(stored.metadata, context), models });
	cleanup.push(() => again.close());
	expect((await again.lane.inspectExecution(context)).current).toBeNull();
	expect(faux.state.callCount).toBe(1);
});

it("rejects unsolicited tool calls without an execution environment", async () => {
	const { runtime, faux } = await fixture();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf should-never-execute" }), { stopReason: "toolUse" }),
		(input) => {
			expect(input.tools?.map((tool) => tool.name)).toEqual(toolNames);
			expect(input.messages).toContainEqual(
				expect.objectContaining({
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: 'Tool "bash" is unavailable' }],
				}),
			);
			return fauxAssistantMessage("I can help using the details you provide.");
		},
	]);
	const admitted = await runtime.controller.prompt({ message: "Help with my room" }, context);
	expect(admitted.accepted).toBe(true);
	await runtime.lane.waitForIdle(context);
	expect((await runtime.harness.getTools(context)).map((tool) => tool.name)).toEqual(toolNames);
	expect(await runtime.lane.getActiveTools(context)).toEqual(toolNames);
	expect(faux.state.callCount).toBe(2);
	const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
	expect(entries.at(-1)).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
});

it("accepts ordinary text and a valid structured action", async () => {
	const { runtime, faux } = await fixture();
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain('"type":"add_asset"');
			expect(input.systemPrompt).toContain('"selectedProductId":"lamp-1"');
			expect(input.systemPrompt).toContain('"quantity":2');
			return fauxAssistantMessage("Noted");
		},
	]);
	expect(
		await runtime.controller.prompt(
			{ message: "Add two lamps", action: { type: "add_asset", selectedProductId: "lamp-1", quantity: 2 } },
			context,
		),
	).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
});

it.each([
	null,
	{ type: "add_asset", selectedProductId: "lamp-1", quantity: 0 },
	{ type: "add_asset", selectedProductId: "lamp-1", quantity: 1.5 },
	{ type: "add_asset", quantity: 1 },
	{ type: "add_asset", selectedProductId: "   ", quantity: 1 },
	{ type: "replace_asset", selectedProductId: "sofa-123" },
	{ type: "move_object", selectedProductId: "sofa-123" },
])("rejects malformed action %j without starting or persisting an operation", async (action) => {
	const { runtime, faux } = await fixture();
	const operations = { kind: "value" as const, namespace: "livi.studio.operation", key: "" };
	const before = await runtime.studio.journal.session.scanValues(operations, context);
	const result = await runtime.controller.prompt({ message: "Replace this sofa", action } as never, context);
	expect(result).toMatchObject({ accepted: false, operationId: null, error: { code: "invalid_message" } });
	expect(faux.state.callCount).toBe(0);
	expect((await runtime.lane.inspectExecution(context)).current).toBeNull();
	expect(await runtime.studio.journal.session.scanValues(operations, context)).toEqual(before);
});
