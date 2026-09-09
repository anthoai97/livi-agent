import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import {
	CatalogError,
	type CatalogProduct,
	type CatalogSearchResult,
	createMemoryCatalogAccess,
} from "../src/catalog.ts";
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

const yellowSectionalSofa = product("yellow-sectional-sofa", {
	name: "Haven Yellow Sectional Sofa",
	category: "sectional_sofa",
	color: "Yellow",
	imageUrl: "https://cdn.example/haven.jpg",
	productUrl: "https://shop.example/haven",
	dimensions: { width: 2.8, depth: 1.6, height: 0.9, unit: "m" },
});
const yellowSectional = product("yellow-sectional", {
	name: "Cove Yellow Sectional",
	category: "sectional",
	color: "yellow",
	availableColors: ["yellow", "cream"],
});
const yellowLShaped = product("yellow-l-shaped", {
	name: "Bend Yellow L-Shaped Sectional",
	category: "sectional_sofa",
	color: "yellow",
	shape: "L-shaped",
});
const yellowSofa = product("yellow-sofa", { name: "Yellow Sofa", category: "sofa", color: "yellow" });
const navySectional = product("navy-sectional", { name: "Navy Sectional", category: "sectional", color: "navy" });
const uncoloredSectional = product("uncolored-sectional", { name: "Plain Sectional", category: "sectional" });
const unknownCategory = product("yellow-unknown-category", { name: "Yellow Unknown", color: "yellow" });
const usdCheap = product("usd-400", {
	name: "USD Desk",
	category: "desk",
	price: { amountMinor: 40000, currency: "USD" },
	dimensions: { width: 1.2, depth: 0.6, height: 0.75, unit: "m" },
});
const usdExpensive = product("usd-600", {
	name: "USD Desk Deluxe",
	category: "desk",
	price: { amountMinor: 60000, currency: "USD" },
});
const eurDesk = product("eur-100", {
	name: "EUR Desk",
	category: "desk",
	price: { amountMinor: 10000, currency: "EUR" },
});
const unpricedDesk = product("unpriced-desk", { name: "Unpriced Desk", category: "desk" });
const unknownWidth = product("unknown-width", {
	name: "Unknown Width Desk",
	category: "desk",
	dimensions: { width: null, depth: 0.6, height: 0.75, unit: "m" },
});

const catalogProducts = [
	yellowSectionalSofa,
	yellowSectional,
	yellowLShaped,
	yellowSofa,
	navySectional,
	uncoloredSectional,
	unknownCategory,
	usdCheap,
	usdExpensive,
	eurDesk,
	unpricedDesk,
	unknownWidth,
];

function product(catalogId: string, fields: Partial<CatalogProduct> & { name: string }): CatalogProduct {
	return {
		catalogId,
		imageUrl: null,
		productUrl: null,
		imageRef: null,
		dimensions: null,
		price: null,
		category: null,
		style: null,
		color: null,
		materials: null,
		shape: null,
		availableColors: null,
		description: null,
		reasons: [],
		...fields,
	};
}

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
				id: "sofa-1",
				name: "Current sofa",
				category: "sofa",
				dimensions: [2, 1, 0.9],
				position: [1, 2, 0],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
				product: { catalogId: "current-sofa", price: null },
			},
		],
		selectedObjectIds: ["sofa-1"],
		budget: { amountMinor: 500000, currency: "USD" },
	};
}

async function attachStudio(broker: StudioBroker) {
	const connection = broker.attach();
	const binding = { designId: "simulated-room", tabId: "simulated-tab" };
	const { generation } = await connection.service.register(
		{ ...binding, label: "Simulated Studio", contractVersion: 2 },
		context,
	);
	const state = {
		snapshot: room(),
		sequence: 0,
		commands: [] as StudioCommand[],
		errors: [] as unknown[],
	};
	const seen = new Set<string>();
	const unsubscribe = connection.service.mailbox.subscribe((mailbox) => {
		for (const request of mailbox.requests) {
			if (seen.has(request.requestId)) continue;
			seen.add(request.requestId);
			void respond(request).catch((error: unknown) => state.errors.push(error));
		}
	});
	cleanup.push(() => {
		unsubscribe();
		connection.release();
		expect(state.errors).toEqual([]);
	});
	async function respond(request: StudioMailboxRequest) {
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
		const command = request.command;
		state.commands.push(command);
		const object = state.snapshot.objects.find((entry) => entry.id === command.objectId)!;
		const before = {
			position: [...object.position] as [number, number, number],
			rotation: [...object.rotation] as [number, number, number],
			scale: [...object.scale] as [number, number, number],
		};
		if (command.action.type === "remove")
			state.snapshot.objects = state.snapshot.objects.filter((entry) => entry.id !== command.objectId);
		state.snapshot.revision = String(Number(state.snapshot.revision) + 1);
		const result: StudioCommandResult = {
			commandId: command.commandId,
			status: "saved",
			revision: state.snapshot.revision,
			snapshot: structuredClone(state.snapshot),
			before,
			after:
				command.action.type === "remove"
					? null
					: { position: object.position, rotation: object.rotation, scale: object.scale },
		};
		await connection.service.respond({ requestId: request.requestId, generation, type: "result", result }, context);
	}
	await connection.service.ready(generation, context);
	await expect.poll(() => broker.getState(binding).phase).toBe("ready");
	return { binding, state };
}

async function session(options: { catalog?: ReturnType<typeof createMemoryCatalogAccess>; studio?: boolean } = {}) {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const stored = await repo.create({}, context);
	const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.5-flash-lite" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const broker = options.studio ? new StudioBroker({ timeoutMs: 500 }) : undefined;
	const fake = broker ? await attachStudio(broker) : undefined;
	const catalog = options.catalog;
	const runtime = await DecoratorSession.create({ session: stored, models, studio: broker, catalog });
	cleanup.push(async () => {
		await broker?.close();
		await runtime.close();
	});
	if (fake && broker) await runtime.studio.service.bind(fake.binding, context);
	return { runtime, faux, fake };
}

const invocation = {
	invocationId: "invocation",
	operationId: "operation",
	turnId: "turn",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

async function search(catalog: ReturnType<typeof createMemoryCatalogAccess>, args: Record<string, unknown>) {
	const { runtime } = await session({ catalog });
	const tool = createStudioTools().find((entry) => entry.name === "search_catalog")!;
	return tool.execute(
		"call",
		args as never,
		() => {},
		{ studio: runtime.studio, planning: undefined, catalog },
		invocation,
		context,
	);
}

it("search_catalog matches yellow sectionals including L-shaped and excludes distractors", async () => {
	const result = await search(createMemoryCatalogAccess(catalogProducts), { color: "yellow", category: "sectional" });
	const payload = result.details as CatalogSearchResult;
	expect(JSON.parse(result.content[0] && result.content[0].type === "text" ? result.content[0].text : "")).toEqual(
		payload,
	);
	expect(payload.products.map((entry) => entry.catalogId).sort()).toEqual([
		"yellow-l-shaped",
		"yellow-sectional",
		"yellow-sectional-sofa",
	]);
	expect(payload.products.find((entry) => entry.catalogId === "yellow-l-shaped")?.shape).toBe("L-shaped");
	expect(payload.products.every((entry) => entry.reasons.length > 0)).toBe(true);
	expect(payload.resolvedConstraints).toMatchObject({
		category: ["sectional", "sectional_sofa"],
		color: "yellow",
	});
	const haven = payload.products.find((entry) => entry.catalogId === "yellow-sectional-sofa")!;
	expect(haven).toMatchObject({
		catalogId: "yellow-sectional-sofa",
		name: "Haven Yellow Sectional Sofa",
		imageUrl: "https://cdn.example/haven.jpg",
		imageRef: "https://cdn.example/haven.jpg",
		productUrl: "https://shop.example/haven",
		dimensions: { width: 2.8, depth: 1.6, height: 0.9, unit: "m" },
		price: null,
	});
});

it("omits signed image and product URLs from catalog tool details", async () => {
	const signed = product("signed-sectional", {
		name: "Signed Sectional",
		category: "sectional",
		color: "yellow",
		imageUrl: "https://cdn.example/object/sign/sofa.jpg?token=secret-token&X-Amz-Signature=sig",
		imageRef: "https://cdn.example/object/sign/sofa.jpg?token=secret-token",
		productUrl: "https://shop.example/buy?se=1&sig=abc",
	});
	const s3 = product("s3-sectional", {
		name: "S3 Sectional",
		category: "sectional",
		color: "yellow",
		imageUrl: "s3://bucket/sofa.png",
		imageRef: "s3://bucket/sofa.png",
	});
	const result = await search(createMemoryCatalogAccess([signed, s3]), { color: "yellow", category: "sectional" });
	const serialized = JSON.stringify(result.details);
	expect(serialized).not.toMatch(/secret-token|X-Amz-Signature|sig=abc|[?&]se=/i);
	const payload = result.details as CatalogSearchResult;
	expect(payload.products.find((entry) => entry.catalogId === "signed-sectional")).toMatchObject({
		imageUrl: null,
		imageRef: null,
		productUrl: null,
	});
	expect(payload.products.find((entry) => entry.catalogId === "s3-sectional")).toMatchObject({
		imageUrl: null,
		imageRef: "s3://bucket/sofa.png",
	});
});

it("unknown color, category, dimensions, and mixed currency cannot satisfy required filters", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	expect((await search(catalog, { color: "yellow", category: "sectional" })).details).toMatchObject({
		products: expect.any(Array),
	});
	expect(
		((await search(catalog, { category: "sectional", color: "yellow" })).details as CatalogSearchResult).products,
	).toHaveLength(3);
	expect(
		((await search(catalog, { category: "sectional", color: "chartreuse" })).details as CatalogSearchResult).products,
	).toEqual([]);
	expect(
		((await search(catalog, { color: "yellow", category: "sectional" })).details as CatalogSearchResult).products.map(
			(entry) => entry.catalogId,
		),
	).not.toContain("uncolored-sectional");
	expect(
		((await search(catalog, { color: "yellow", category: "sectional" })).details as CatalogSearchResult).products.map(
			(entry) => entry.catalogId,
		),
	).not.toContain("yellow-unknown-category");
	expect(
		((await search(catalog, { category: "desk", maxWidth: 1.5 })).details as CatalogSearchResult).products.map(
			(entry) => entry.catalogId,
		),
	).toEqual(["usd-400"]);
	expect(
		(
			(await search(catalog, { category: "desk", maxAmountMinor: 50000, currency: "USD" }))
				.details as CatalogSearchResult
		).products.map((entry) => entry.catalogId),
	).toEqual(["usd-400"]);
});

it("explains unsupported price filters instead of dropping them", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	await expect(search(catalog, { category: "desk", maxAmountMinor: 50000 })).rejects.toBeInstanceOf(CatalogError);
	await expect(search(catalog, { category: "desk", maxAmountMinor: 50000 })).rejects.toThrow(/unsupported_filter/);
	await expect(search(catalog, { category: "desk", currency: "USD" })).rejects.toThrow(/unsupported_filter/);
});

it("returns an exhausted empty catalog search without mutations", async () => {
	const result = await search(createMemoryCatalogAccess(catalogProducts), { color: "purple", category: "sectional" });
	expect(result.details).toMatchObject({
		products: [],
		pagination: { exhausted: true, offset: 0 },
	});
});

it("catalog-unavailable search does not invent products", async () => {
	const { runtime, faux } = await session();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
			stopReason: "toolUse",
		}),
		(input) => {
			expect(JSON.stringify(input.messages)).toContain("catalog_unavailable");
			return fauxAssistantMessage("The catalog is unavailable.");
		},
	]);
	expect(await runtime.controller.prompt({ message: "Find a yellow sectional" }, context)).toMatchObject({
		accepted: true,
	});
	await runtime.lane.waitForIdle(context);
	const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
	const toolResult = entries.find(
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "search_catalog",
	);
	expect(toolResult).toMatchObject({
		type: "message",
		message: { role: "toolResult", isError: true },
	});
	expect(JSON.stringify(toolResult)).toContain("catalog_unavailable");
	expect(JSON.stringify(toolResult)).not.toContain("Haven Yellow");
});

it("get_product_details returns the snapshot or not-found", async () => {
	const { runtime } = await session({ catalog: createMemoryCatalogAccess(catalogProducts) });
	const tool = createStudioTools().find((entry) => entry.name === "get_product_details")!;
	const found = await tool.execute(
		"call",
		{ catalogId: "yellow-sectional-sofa" },
		() => {},
		{ studio: runtime.studio, planning: undefined, catalog: createMemoryCatalogAccess(catalogProducts) },
		invocation,
		context,
	);
	expect(found.details).toMatchObject({
		product: { catalogId: "yellow-sectional-sofa", name: "Haven Yellow Sectional Sofa", price: null },
	});
	await expect(
		tool.execute(
			"call",
			{ catalogId: "missing-product" },
			() => {},
			{ studio: runtime.studio, planning: undefined, catalog: createMemoryCatalogAccess(catalogProducts) },
			invocation,
			context,
		),
	).rejects.toThrow(/not_found/);
});

it("replacement prompt searches yellow sectionals and does not change the room", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const { runtime, faux, fake } = await session({ catalog, studio: true });
	faux.setResponses([
		(input) => {
			expect(input.systemPrompt).toContain("search_catalog");
			expect(input.systemPrompt).toContain("Never remove the current object");
			return fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Here are yellow sectional sofas to consider."),
	]);
	expect(
		await runtime.controller.prompt(
			{ message: "Can you replace the current sofa with a yello sectional sofa" },
			context,
		),
	).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
	const toolResult = entries.find(
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "search_catalog",
	);
	expect(
		toolResult?.type === "message" && toolResult.message.role === "toolResult" ? toolResult.message.isError : true,
	).toBe(false);
	const details =
		toolResult?.type === "message" && toolResult.message.role === "toolResult"
			? (toolResult.message.details as CatalogSearchResult)
			: undefined;
	expect(details?.products.map((entry) => entry.catalogId).sort()).toEqual([
		"yellow-l-shaped",
		"yellow-sectional",
		"yellow-sectional-sofa",
	]);
	expect(details?.products.map((entry) => entry.catalogId)).not.toEqual(
		expect.arrayContaining(["yellow-sofa", "navy-sectional"]),
	);
	expect(fake?.state.commands).toEqual([]);
	expect(fake?.state.snapshot.objects.map((object) => object.id)).toEqual(["sofa-1"]);
	expect(await runtime.studio.journal.records()).toEqual([]);
});
