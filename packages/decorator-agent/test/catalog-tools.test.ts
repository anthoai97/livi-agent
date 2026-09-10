import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import {
	type CatalogProduct,
	type CatalogRecommendationDetails,
	createMemoryCatalogAccess,
	mergeCatalogFollowUp,
} from "../src/catalog.ts";
import { loadRecommendationHistory } from "../src/catalog-history.ts";
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
const usdMini = product("usd-250", {
	name: "USD Desk Mini",
	category: "desk",
	price: { amountMinor: 25000, currency: "USD" },
	dimensions: { width: 0.8, depth: 0.5, height: 0.7, unit: "m" },
});
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
	usdMini,
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

async function session(
	options: { catalog?: ReturnType<typeof createMemoryCatalogAccess>; studio?: boolean; contextWindow?: number } = {},
) {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const stored = await repo.create({}, context);
	const faux = fauxProvider({
		provider: "google",
		models: [{ id: "gemini-3.8-flash", contextWindow: options.contextWindow }],
	});
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
	return { runtime, faux, fake, repo, stored, models, catalog };
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
	const payload = result.details as CatalogRecommendationDetails;
	const modelPayload = JSON.parse(
		result.content[0] && result.content[0].type === "text" ? result.content[0].text : "",
	);
	expect(modelPayload).toMatchObject({
		kind: payload.kind,
		searchId: payload.searchId,
		products: payload.products.map(({ catalogId, name, price, dimensions }) => ({
			catalogId,
			name,
			price,
			dimensions,
		})),
	});
	expect(JSON.stringify(modelPayload)).not.toContain("https://");
	expect(payload.kind).toBe("catalog_recommendations");
	expect(payload.searchId).toBe("invocation");
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
	const payload = result.details as CatalogRecommendationDetails;
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
	const yellow = (
		(await search(catalog, { color: "yellow", category: "sectional" })).details as CatalogRecommendationDetails
	).products.map((entry) => entry.catalogId);
	expect(yellow).not.toContain("uncolored-sectional");
	expect(yellow).not.toContain("yellow-unknown-category");
	expect((await search(catalog, { category: "sectional", color: "chartreuse" })).details).toMatchObject({
		products: [],
		pagination: { exhausted: true, offset: 0 },
	});
	expect(
		(
			(await search(catalog, { category: "desk", maxWidth: 1.5 })).details as CatalogRecommendationDetails
		).products.map((entry) => entry.catalogId),
	).toEqual(["usd-400", "usd-250"]);
	expect(
		(
			(await search(catalog, { category: "desk", maxAmountMinor: 50000, currency: "USD" }))
				.details as CatalogRecommendationDetails
		).products.map((entry) => entry.catalogId),
	).toEqual(["usd-400", "usd-250"]);
});

it("rejects a currency without a price bound", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	await expect(search(catalog, { category: "desk", currency: "USD" })).rejects.toThrow(/unsupported_filter/);
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
			? (toolResult.message.details as CatalogRecommendationDetails)
			: undefined;
	expect(details?.products.map((entry) => entry.catalogId).sort()).toEqual([
		"yellow-l-shaped",
		"yellow-sectional",
		"yellow-sectional-sofa",
	]);
	expect(details?.products.map((entry) => entry.catalogId)).not.toEqual(
		expect.arrayContaining(["yellow-sofa", "navy-sectional"]),
	);
	expect(details?.kind).toBe("catalog_recommendations");
	expect(details?.searchId).toEqual(expect.any(String));
	expect(details?.shownIds.sort()).toEqual(["yellow-l-shaped", "yellow-sectional", "yellow-sectional-sofa"]);
	expect(fake?.state.commands).toEqual([]);
	expect(fake?.state.snapshot.objects.map((object) => object.id)).toEqual(["sofa-1"]);
	expect(await runtime.studio.journal.records()).toEqual([]);
});

function searchDetails(entries: Awaited<ReturnType<DecoratorSession["lane"]["findEntries"]>>) {
	const toolResult = [...entries]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "search_catalog" &&
				!entry.message.isError,
		);
	if (toolResult?.type !== "message" || toolResult.message.role !== "toolResult") return undefined;
	return toolResult.message.details as CatalogRecommendationDetails;
}

it("follow-ups cheaper, smaller, and show more change only the intended constraint", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const { runtime, faux, fake } = await session({ catalog, studio: true });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { category: "desk", limit: 1 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Here is a desk."),
		fauxAssistantMessage(fauxToolCall("search_catalog", { followUp: "show_more" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("More desks."),
		fauxAssistantMessage(
			fauxToolCall("search_catalog", {
				category: "desk",
				maxAmountMinor: 50000,
				currency: "USD",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Priced desks."),
		fauxAssistantMessage(fauxToolCall("search_catalog", { followUp: "cheaper", referenceCatalogId: "usd-400" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Cheaper desks."),
		fauxAssistantMessage(
			fauxToolCall("search_catalog", { followUp: "smaller", referenceCatalogId: "usd-400", dimension: "width" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Smaller desks."),
	]);
	expect(await runtime.controller.prompt({ message: "Show desks" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	const first = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(first?.products.map((product) => product.catalogId)).toEqual(["eur-100"]);
	expect(first?.pagination.limit).toBe(1);
	expect(await runtime.controller.prompt({ message: "Show more" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	const more = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(more?.searchId).toBe(first?.searchId);
	expect(more?.followUp).toBe("show_more");
	expect(more?.resolvedConstraints.category).toEqual(["desk", "writing_desk"]);
	expect(more?.products.map((product) => product.catalogId)).not.toContain("eur-100");
	expect(more?.shownIds).toEqual(
		expect.arrayContaining([...(first?.shownIds ?? []), ...(more?.products.map((p) => p.catalogId) ?? [])]),
	);
	expect(await runtime.controller.prompt({ message: "USD desks under 500" }, context)).toMatchObject({
		accepted: true,
	});
	await runtime.lane.waitForIdle(context);
	const priced = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(priced?.searchId).not.toBe(first?.searchId);
	expect(await runtime.controller.prompt({ message: "Cheaper than the 400 desk" }, context)).toMatchObject({
		accepted: true,
	});
	await runtime.lane.waitForIdle(context);
	const cheaper = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(cheaper?.searchId).toBe(priced?.searchId);
	expect(cheaper?.followUp).toBe("cheaper");
	expect(cheaper?.resolvedConstraints.category).toEqual(["desk", "writing_desk"]);
	expect(cheaper?.resolvedConstraints.maxPrice).toEqual({ amountMinor: 39999, currency: "USD" });
	expect(cheaper?.products.map((product) => product.catalogId)).toEqual(["usd-250"]);
	expect(await runtime.controller.prompt({ message: "Smaller width than the 400 desk" }, context)).toMatchObject({
		accepted: true,
	});
	await runtime.lane.waitForIdle(context);
	const smaller = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(smaller?.searchId).toBe(priced?.searchId);
	expect(smaller?.followUp).toBe("smaller");
	expect(smaller?.resolvedConstraints.category).toEqual(["desk", "writing_desk"]);
	expect(smaller?.resolvedConstraints.maxWidth).toBe(1.2);
	expect(smaller?.products.map((product) => product.catalogId)).toEqual(["usd-250"]);
	expect(fake?.state.commands).toEqual([]);
});

it("cheaper without a priced reference asks for clarification", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const { runtime, faux } = await session({ catalog });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Yellow sectionals."),
		fauxAssistantMessage(fauxToolCall("search_catalog", { followUp: "cheaper" }), { stopReason: "toolUse" }),
		(input) => {
			expect(JSON.stringify(input.messages)).toMatch(/invalid_arguments|verified same-currency|Identify which/);
			return fauxAssistantMessage("Which product should I compare?");
		},
	]);
	expect(await runtime.controller.prompt({ message: "Yellow sectionals" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	expect(await runtime.controller.prompt({ message: "Cheaper" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
});

it("restores catalog snapshots after reopen without rerunning search", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const { runtime, faux, repo, stored, models } = await session({ catalog });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Here are yellow sectional sofas to consider."),
	]);
	expect(await runtime.controller.prompt({ message: "Yellow sectionals" }, context)).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	const before = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	const calls = faux.state.callCount;
	await runtime.close();
	const recovered = await DecoratorSession.create({
		session: await repo.open(stored.metadata, context),
		models,
		catalog,
	});
	cleanup.push(() => recovered.close());
	await recovered.lane.waitForIdle(context);
	const after = searchDetails(await recovered.lane.findEntries({ order: "oldestFirst" }, context));
	expect(after?.searchId).toBe(before?.searchId);
	expect(after?.products.map((product) => product.catalogId)).toEqual(
		before?.products.map((product) => product.catalogId),
	);
	expect(faux.state.callCount).toBe(calls);
});

it("keeps catalog follow-up state isolated by conversation", async () => {
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const first = await session({ catalog });
	const second = await session({ catalog });
	first.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Yellow sectionals."),
	]);
	second.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { followUp: "show_more" }), { stopReason: "toolUse" }),
		(input) => {
			expect(JSON.stringify(input.messages)).toContain("invalid_arguments");
			return fauxAssistantMessage("No prior search in this conversation.");
		},
	]);
	expect(await first.runtime.controller.prompt({ message: "Yellow sectionals" }, context)).toMatchObject({
		accepted: true,
	});
	await first.runtime.lane.waitForIdle(context);
	expect(await second.runtime.controller.prompt({ message: "Show more" }, context)).toMatchObject({ accepted: true });
	await second.runtime.lane.waitForIdle(context);
});

it("mergeCatalogFollowUp keeps filters and applies cheaper or smaller bounds", () => {
	const prior: CatalogRecommendationDetails = {
		kind: "catalog_recommendations",
		searchId: "search-1",
		products: [usdCheap],
		resolvedConstraints: { category: ["desk"], color: "oak" },
		pagination: { limit: 8, offset: 0, exhausted: false },
		shownIds: ["usd-400"],
		binding: { designId: "room-a" },
		followUp: null,
	};
	const cheaper = mergeCatalogFollowUp(prior, "cheaper");
	expect(cheaper.searchId).toBe("search-1");
	expect(cheaper.request.category).toBe("desk");
	expect(cheaper.request.color).toBe("oak");
	expect(cheaper.request.maxPrice).toEqual({ amountMinor: 39999, currency: "USD" });
	expect(cheaper.shownIds).toEqual([]);
	const more = mergeCatalogFollowUp(prior, "show_more");
	expect(more.request.omitIds).toEqual(["usd-400"]);
	expect(more.shownIds).toEqual(["usd-400"]);
	const smaller = mergeCatalogFollowUp(prior, "smaller", { dimension: "width" });
	expect(smaller.request.maxWidth).toBe(1.2);
	expect(smaller.request.exclusiveMaxWidth).toBe(true);
});

for (const order of ["before", "after", "after_error"] as const) {
	it(`forwards a requested move ${order} catalog search without locking the request`, async () => {
		const { runtime, faux, fake } = await session({
			catalog: createMemoryCatalogAccess(catalogProducts),
			studio: true,
		});
		const searchCall = fauxToolCall("search_catalog", {
			purpose: "recommendation",
			category: "sectional",
			...(order === "after_error" ? { currency: "USD" } : {}),
		});
		const moveCall = fauxToolCall("move_object", { objectId: "sofa-1", position: [2, 2, 0] });
		faux.setResponses([
			fauxAssistantMessage(order === "before" ? [moveCall, searchCall] : [searchCall, moveCall], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Moved the sofa and searched for options."),
		]);
		await runtime.controller.prompt({ message: "Move the sofa to [2,2,0] and show sectional options" }, context);
		await runtime.lane.waitForIdle(context);
		expect(fake?.state.commands).toHaveLength(1);
		expect(fake?.state.commands[0]?.action).toEqual({ type: "move", position: [2, 2, 0] });
		const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
		expect(JSON.stringify(entries)).not.toContain("mutation_blocked");
	});
}

it("preserves original target, query and exclusions through detachment and show_more", async () => {
	const { runtime, faux, fake } = await session({ catalog: createMemoryCatalogAccess(catalogProducts), studio: true });
	fake!.state.snapshot.selectedObjectIds = [];
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("search_catalog", {
				category: "sectional",
				color: "yellow",
				limit: 1,
				excludeIds: ["yellow-l-shaped"],
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("One option."),
		fauxAssistantMessage(fauxToolCall("search_catalog", { followUp: "show_more" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("More options."),
	]);
	const originalQuery = "Can you replace the current sofa with a yello sectional sofa";
	await runtime.controller.prompt({ message: originalQuery }, context);
	await runtime.lane.waitForIdle(context);
	const first = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context))!;
	expect(first.resolvedConstraints).toMatchObject({
		originalQuery,
		purpose: "replacement",
		target: { objectId: "sofa-1", revision: "1", designId: "simulated-room" },
		excludeIds: ["yellow-l-shaped", "current-sofa"],
	});
	expect(first.resolvedConstraints.minPrice).toBeUndefined();
	expect(first.resolvedConstraints.maxPrice).toBeUndefined();
	await runtime.studio.service.bind(null, context);
	await runtime.controller.prompt({ message: "Show more" }, context);
	await runtime.lane.waitForIdle(context);
	const more = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context))!;
	expect(more.binding).toEqual(first.binding);
	expect(more.resolvedConstraints.target).toEqual(first.resolvedConstraints.target);
	expect(more.resolvedConstraints.originalQuery).toBe(originalQuery);
	expect(more.products.some((p) => p.catalogId === "yellow-l-shaped")).toBe(false);
	expect(more.products.some((p) => first.shownIds.includes(p.catalogId))).toBe(false);
});

it("refinements reset traversal exclusions while keeping intentional exclusions and tighter bounds", () => {
	const prior: CatalogRecommendationDetails = {
		kind: "catalog_recommendations",
		searchId: "s",
		products: [usdCheap],
		resolvedConstraints: {
			category: ["desk"],
			excludeIds: ["blocked"],
			maxPrice: { amountMinor: 30000, currency: "USD" },
			maxWidth: 0.9,
			exclusiveMaxWidth: true,
		},
		pagination: { offset: 0, limit: 8, exhausted: false },
		shownIds: ["usd-250", "usd-400"],
		binding: null,
		followUp: "show_more",
	};
	const cheaper = mergeCatalogFollowUp(prior, "cheaper").request;
	expect(cheaper.maxPrice?.amountMinor).toBe(30000);
	expect(cheaper.excludeIds).toEqual(["blocked"]);
	expect(cheaper.omitIds).toBeUndefined();
	const smaller = mergeCatalogFollowUp(prior, "smaller", { dimension: "width" }).request;
	expect(smaller.maxWidth).toBe(0.9);
	expect(smaller.exclusiveMaxWidth).toBe(true);
	expect(smaller.excludeIds).toEqual(["blocked"]);
	const otherCurrency = { ...prior, resolvedConstraints: { maxPrice: { amountMinor: 20000, currency: "EUR" } } };
	expect(() => mergeCatalogFollowUp(otherCurrency, "cheaper")).toThrow(/currency/);
});

it("rejects missing named sofa and an explicit target that conflicts with the named sofa", async () => {
	for (const missing of [true, false]) {
		const { runtime, fake } = await session({ catalog: createMemoryCatalogAccess(catalogProducts), studio: true });
		const snapshot = structuredClone(fake!.state.snapshot);
		const chair = { ...snapshot.objects[0]!, id: "chair-1", name: "Chair", category: "accent_chair" };
		snapshot.objects = missing ? [chair] : [...snapshot.objects, chair];
		snapshot.selectedObjectIds = ["chair-1"];
		const tool = createStudioTools().find((t) => t.name === "search_catalog")!;
		await expect(
			tool.execute(
				"call",
				{ category: "sectional", purpose: "replacement", ...(missing ? {} : { targetObjectId: "chair-1" }) },
				() => {},
				{
					studio: runtime.studio,
					catalog: createMemoryCatalogAccess(catalogProducts),
					planning: {
						operationId: "operation",
						turnId: "turn",
						binding: fake!.binding,
						snapshot,
						action: null,
						unavailable: null,
						originalQuery: "Replace the sofa with a sectional",
					},
				},
				invocation,
				context,
			),
		).rejects.toThrow(/named/);
	}
});

it("grounds exact object names and punctuation without blocking an independent position swap", async () => {
	const { runtime, fake } = await session({ catalog: createMemoryCatalogAccess(catalogProducts), studio: true });
	const snapshot = structuredClone(fake!.state.snapshot);
	const catalog = createMemoryCatalogAccess(catalogProducts);
	const tool = createStudioTools().find((t) => t.name === "search_catalog")!;
	for (const [message, name, category] of [
		["Replace my Reading nook with a sectional", "Reading nook", "accent_chair"],
		["Replace the sofa.", "Sofa", "sofa"],
	]) {
		snapshot.objects[0]!.name = name!;
		snapshot.objects[0]!.category = category!;
		const result = await tool.execute(
			"call",
			{ category: "sectional", targetObjectId: "sofa-1" },
			() => {},
			{
				studio: runtime.studio,
				catalog,
				planning: {
					operationId: "operation",
					turnId: "turn",
					binding: fake!.binding,
					snapshot,
					action: null,
					unavailable: null,
					originalQuery: message,
				},
			},
			invocation,
			context,
		);
		expect((result.details as CatalogRecommendationDetails).resolvedConstraints.target?.objectId).toBe("sofa-1");
	}
	const move = createStudioTools().find((t) => t.name === "move_object")!;
	const swapInvocation = { ...invocation, operationId: "swap", invocationId: "swap-move" };
	await move.execute(
		"call",
		{ objectId: "sofa-1", position: [2, 2, 0] },
		() => {},
		{
			studio: runtime.studio,
			catalog,
			planning: {
				operationId: "swap",
				turnId: "turn",
				binding: fake!.binding,
				snapshot,
				action: null,
				unavailable: null,
				originalQuery: "Swap the positions of the sofa and chair",
			},
		},
		swapInvocation,
		context,
	);
	expect(fake!.state.commands).toHaveLength(1);
});

it("defaults an explicit price bound to USD without adding a room budget", async () => {
	const { runtime, faux } = await session({ catalog: createMemoryCatalogAccess(catalogProducts) });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { category: "desk", maxAmountMinor: 50000 }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Desks under $500."),
	]);
	await runtime.controller.prompt({ message: "Show desks under 500" }, context);
	await runtime.lane.waitForIdle(context);
	const result = searchDetails(await runtime.lane.findEntries({ order: "oldestFirst" }, context));
	expect(result?.resolvedConstraints.maxPrice).toEqual({ amountMinor: 50000, currency: "USD" });
	expect(result?.products.map((p) => p.catalogId).sort()).toEqual(["usd-250", "usd-400"]);
});

async function compactAutomatically(runtime: DecoratorSession, faux: ReturnType<typeof fauxProvider>) {
	const before = (await runtime.studio.session.findEntries({ type: "compaction" }, context)).length;
	faux.setResponses(
		Array.from(
			{ length: 12 },
			() => (input: ModelContext) =>
				fauxAssistantMessage(
					input.systemPrompt?.includes("context summarization assistant")
						? "Discussed furniture. Exact product and saved action identifiers are omitted."
						: "Understood.",
				),
		),
	);
	expect(
		await runtime.controller.prompt(
			{ message: `Consider these room notes: ${"neutral notes ".repeat(8000)}` },
			context,
		),
	).toMatchObject({ accepted: true });
	await runtime.lane.waitForIdle(context);
	const entries = await runtime.studio.session.findEntries({ type: "compaction" }, context);
	expect(entries.length).toBeGreaterThan(before);
	const latest = entries[0]!;
	expect(latest.type).toBe("compaction");
	if (latest.type === "compaction")
		expect(latest.retainedTail.some((message) => message.role === "toolResult")).toBe(false);
}

it("keeps catalog follow-ups and exact comparison references after repeated automatic compaction and reload", async () => {
	const fixture = await session({ catalog: createMemoryCatalogAccess(catalogProducts), contextWindow: 40000 });
	const { runtime, faux, repo, stored, models, catalog } = fixture;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { category: "desk", maxAmountMinor: 50000, limit: 1 }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("One desk."),
	]);
	await runtime.controller.prompt({ message: "Show desks under 500 USD" }, context);
	await runtime.lane.waitForIdle(context);
	const first = (await loadRecommendationHistory(stored, context))[0]!;
	expect(first.products.map((entry) => entry.catalogId)).toEqual(["usd-400"]);
	await compactAutomatically(runtime, faux);
	await compactAutomatically(runtime, faux);
	await runtime.close();
	const recovered = await DecoratorSession.create({
		session: await repo.open(stored.metadata, context),
		models,
		catalog,
	});
	cleanup.push(() => recovered.close());
	for (const followUp of ["show_more", "cheaper", "smaller"] as const) {
		let generations = 0;
		faux.setResponses(
			Array.from({ length: 12 }, () => (input: ModelContext) => {
				if (input.systemPrompt?.includes("context summarization assistant"))
					return fauxAssistantMessage("Discussed furniture. Exact identifiers are omitted.");
				expect(input.systemPrompt).toContain(first.searchId);
				if (generations++ > 0) return fauxAssistantMessage("Here is a smaller desk.");
				return fauxAssistantMessage(
					fauxToolCall("search_catalog", {
						followUp,
						searchId: first.searchId,
						...(followUp === "show_more" ? {} : { referenceCatalogId: "usd-400" }),
						...(followUp === "smaller" ? { dimension: "width" } : {}),
					}),
					{ stopReason: "toolUse" },
				);
			}),
		);
		await recovered.controller.prompt({ message: followUp }, context);
		await recovered.lane.waitForIdle(context);
		const latest = (await loadRecommendationHistory(recovered.studio.session, context))[0]!;
		expect(latest.searchId).toBe(first.searchId);
		expect(latest.followUp).toBe(followUp);
		expect(latest.products.map((entry) => entry.catalogId)).toEqual(["usd-250"]);
		if (followUp === "show_more") expect(latest.shownIds).toEqual(["usd-400", "usd-250"]);
		else expect(latest.resolvedConstraints.maxPrice).toEqual({ amountMinor: 39999, currency: "USD" });
		if (followUp === "smaller") expect(latest.resolvedConstraints.maxWidth).toBe(1.2);
	}
});
