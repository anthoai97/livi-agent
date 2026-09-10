import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { type CatalogProduct, type CatalogRecommendationDetails, createMemoryCatalogAccess } from "../src/catalog.ts";
import { DecoratorSession } from "../src/decorator-session.ts";
import {
	CATALOG_CONTEXT_BYTES,
	catalogModelContext,
	modelRecords,
	ROOM_CONTEXT_BYTES,
	roomModelContext,
} from "../src/model-context.ts";
import type { StudioObject } from "../src/services/studio.ts";
import type { StudioPlanningSnapshot } from "../src/studio-journal.ts";

const longText = "家具🌿".repeat(5_000);

function product(catalogId: string): CatalogProduct {
	return {
		catalogId,
		name: longText,
		description: longText,
		imageUrl: `https://example.com/${longText}`,
		productUrl: `https://example.com/${longText}`,
		imageRef: `s3://bucket/${longText}`,
		price: { amountMinor: 12345, currency: "USD" },
		dimensions: { width: 1.25, height: null, depth: 0.75, unit: "m" },
		category: "chair",
		style: null,
		color: "green",
		materials: null,
		shape: null,
		availableColors: Array.from({ length: 100 }, () => longText),
		reasons: [longText],
	};
}

function recommendations(products: CatalogProduct[]): CatalogRecommendationDetails {
	return {
		kind: "catalog_recommendations",
		searchId: "search-精確-reference",
		products,
		resolvedConstraints: {
			query: longText,
			excludeIds: Array.from({ length: 500 }, (_, index) => `${index}-${longText}`),
		},
		pagination: { limit: 20, offset: 0, nextOffset: 20, exhausted: false },
		shownIds: Array.from({ length: 500 }, (_, index) => `${index}-${longText}`),
		binding: { designId: "room-exact" },
		followUp: null,
	};
}

function planning(): StudioPlanningSnapshot & { snapshot: NonNullable<StudioPlanningSnapshot["snapshot"]> } {
	return {
		operationId: "operation-exact",
		turnId: "turn-exact",
		binding: { designId: "room-exact", tabId: "tab-exact" },
		action: {
			type: "replace_asset",
			selectedProductId: "new-product-exact",
			targetObjectId: "object-299",
			designId: "room-exact",
			expectedRevision: "revision-精確-42",
			expectedCatalogId: "catalog-299",
		},
		unavailable: null,
		originalQuery: "Replace the sofa",
		snapshot: {
			designId: "room-exact",
			revision: "revision-精確-42",
			geometry: { floor: Array.from({ length: 1_000 }, (_, index) => [index, index]), height: 3 },
			openings: Array.from({ length: 100 }, (_, index) => ({
				id: `window-${index}`,
				kind: "window",
				position: [0, 0, 1],
				dimensions: [1, 0.1, 1],
			})),
			objects: Array.from({ length: 300 }, (_, index) => ({
				id: `object-${index}`,
				name: index === 298 ? "Selected chair" : `${longText}-${index}`,
				category: index === 297 ? "sofa" : "chair",
				position: [index, 2, 0],
				rotation: [0, 0, 0.25],
				scale: [1, 1, 1],
				dimensions: [1, 0.75, 1.2],
				product: { catalogId: `catalog-${index}`, price: { amountMinor: 12345, currency: "USD" } },
			})),
			selectedObjectIds: [
				"object-298",
				...Array.from({ length: 500 }, (_, index) => `missing-${index}-${longText}`),
			],
			budget: null,
		},
	};
}

interface RoomPage {
	objects: (StudioObject & { selected: boolean })[];
	omitted: number;
	revision: string;
	offset: number;
	nextOffset?: number;
}

it("bounds Unicode catalog cards while retaining complete exact references and unchanged UI details", () => {
	const payload = recommendations(Array.from({ length: 20 }, (_, index) => product(`catalog-${index}-精確`)));
	const original = structuredClone(payload);
	const encoded = catalogModelContext(payload);
	const parsed = JSON.parse(encoded) as { products: Partial<CatalogProduct>[]; omitted: number };
	expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CATALOG_CONTEXT_BYTES);
	expect(parsed.products.length).toBeGreaterThan(0);
	expect(parsed.products.length).toBeLessThan(payload.products.length);
	expect(parsed.omitted + parsed.products.length).toBe(payload.products.length);
	expect(parsed).toMatchObject({
		searchId: payload.searchId,
		pagination: payload.pagination,
		resolvedConstraints: { excludedCount: 500 },
		shownCount: 500,
	});
	for (const [index, record] of parsed.products.entries()) {
		expect(record.catalogId).toBe(payload.products[index]?.catalogId);
		expect(record).toMatchObject({
			price: payload.products[index]?.price,
			dimensions: payload.products[index]?.dimensions,
		});
		expect(record).not.toHaveProperty("productUrl");
		expect(record).not.toHaveProperty("description");
		expect(record.availableColors?.length).toBeLessThanOrEqual(8);
	}
	expect(payload).toEqual(original);
});

it("bounds product details without truncating IDs or verified numeric facts", () => {
	const source = product(`catalog-${"精確".repeat(100)}`);
	const original = structuredClone(source);
	const encoded = catalogModelContext({ product: source });
	const parsed = JSON.parse(encoded) as { products: Partial<CatalogProduct>[] };
	expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CATALOG_CONTEXT_BYTES);
	expect(parsed.products).toHaveLength(1);
	expect(parsed.products[0]).toMatchObject({
		catalogId: source.catalogId,
		price: source.price,
		dimensions: source.dimensions,
	});
	expect(parsed.products[0]?.description?.length).toBeLessThan(source.description?.length ?? 0);
	expect(source).toEqual(original);
});

it("omits whole oversized records and returns valid bounded JSON for oversized metadata", () => {
	const oversized = product(longText);
	const result = catalogModelContext({ product: oversized });
	expect(Buffer.byteLength(result)).toBeLessThanOrEqual(CATALOG_CONTEXT_BYTES);
	expect(JSON.parse(result)).toMatchObject({ products: [], omitted: 1 });
	const metadataResult = modelRecords({ searchId: longText }, "products", [{ catalogId: "exact" }], 4_000);
	expect(Buffer.byteLength(metadataResult)).toBeLessThanOrEqual(4_000);
	expect(JSON.parse(metadataResult)).toMatchObject({ unavailable: expect.any(String) });
	expect(metadataResult).not.toContain("[truncated]");
});

it("prioritizes room action, query, and selection while preserving exact revision and transforms", () => {
	const source = planning();
	const original = structuredClone(source);
	const encoded = roomModelContext(source);
	const page = JSON.parse(encoded) as RoomPage;
	expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(ROOM_CONTEXT_BYTES);
	expect(page.objects.slice(0, 3).map(({ id }) => id)).toEqual(["object-299", "object-297", "object-298"]);
	expect(page).toMatchObject({
		revision: source.snapshot.revision,
		action: source.action,
		geometryOmitted: true,
		openingsOmitted: true,
		totalObjects: 300,
	});
	expect(page.objects.length + page.omitted).toBe(300);
	for (const object of page.objects) {
		const full = source.snapshot.objects.find(({ id }) => id === object.id);
		expect(object).toMatchObject({ position: full?.position, dimensions: full?.dimensions, product: full?.product });
	}
	expect(source).toEqual(original);
});

it("retrieves omitted room objects by exact ID, text query, and subsequent page", () => {
	const source = planning();
	const first = JSON.parse(roomModelContext(source)) as RoomPage;
	const second = JSON.parse(roomModelContext(source, { offset: first.objects.length })) as RoomPage;
	expect(second.objects.length).toBeGreaterThan(0);
	expect(second.objects.every((object) => !first.objects.some(({ id }) => id === object.id))).toBe(true);
	const exact = JSON.parse(roomModelContext(source, { objectId: "object-250" })) as RoomPage;
	expect(exact.objects.map(({ id }) => id)).toEqual(["object-250"]);
	expect(exact.revision).toBe(source.snapshot.revision);
	const query = JSON.parse(roomModelContext(source, { query: "SELECTED CHAIR" })) as RoomPage;
	expect(query.objects.map(({ id }) => id)).toEqual(["object-298"]);
	expect(query.objects[0]?.selected).toBe(true);
});

it("advances past an individually oversized room object without shortening its ID", () => {
	const source = planning();
	source.action = null;
	source.originalQuery = "";
	source.snapshot.selectedObjectIds = [];
	const original = source.snapshot.objects[0]!;
	source.snapshot.objects = [
		{ ...original, id: longText },
		{ ...original, id: "reachable-object" },
	];
	const first = JSON.parse(roomModelContext(source)) as RoomPage;
	expect(first.objects).toEqual([]);
	expect(first.omitted).toBe(2);
	expect(first.nextOffset).toBe(1);
	const second = JSON.parse(roomModelContext(source, { offset: first.nextOffset })) as RoomPage;
	expect(second.objects.map(({ id }) => id)).toEqual(["reachable-object"]);
	expect(source.snapshot.objects[0]?.id).toBe(longText);
});

it("publishes full product details to the UI while feeding bounded text to the model", async () => {
	const repo = new MemorySessionRepo();
	const source = product("product-exact");
	const session = await repo.create({}, context);
	const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.8-flash" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await DecoratorSession.create({ session, models, catalog: createMemoryCatalogAccess([source]) });
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("get_product_details", { catalogId: source.catalogId }), {
				stopReason: "toolUse",
			}),
			(input) => {
				const result = input.messages.find((message) => message.role === "toolResult");
				if (!result || result.role !== "toolResult") throw new Error("Expected product detail result");
				const content = result.content[0];
				if (content?.type !== "text") throw new Error("Expected product detail text");
				expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(CATALOG_CONTEXT_BYTES);
				expect(JSON.parse(content.text)).toMatchObject({
					products: [expect.objectContaining({ catalogId: source.catalogId })],
				});
				return fauxAssistantMessage("Here is the product.");
			},
		]);
		expect(await runtime.controller.prompt({ message: "Show product-exact" }, context)).toMatchObject({
			accepted: true,
		});
		await runtime.lane.waitForIdle(context);
		const entries = await runtime.lane.findEntries({ order: "oldestFirst" }, context);
		const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(result).toMatchObject({
			message: {
				details: {
					product: {
						catalogId: source.catalogId,
						name: source.name,
						description: source.description,
						availableColors: source.availableColors,
					},
				},
			},
		});
		expect(faux.state.callCount).toBe(2);
	} finally {
		await runtime.close();
		await repo.close(context);
	}
});
