import { expect, it } from "vitest";
import {
	type CatalogProduct,
	catalogDeadline,
	catalogResolvedConstraints,
	createMemoryCatalogAccess,
	normalizeCatalogSearchRequest,
	requestFromConstraints,
	sanitizeCatalogProduct,
} from "../src/catalog.ts";

it("round trips original intent and grounded evidence without creating financial constraints", () => {
	const originalQuery = "Can you replace the current sofa with a yello sectional sofa";
	const target = { designId: "room", revision: "7", objectId: "sofa-1", catalogId: "old-sofa", category: "sofa" };
	const resolved = catalogResolvedConstraints(
		normalizeCatalogSearchRequest({
			originalQuery,
			query: "yellow sectional",
			purpose: "replacement",
			target,
			excludeIds: ["old-sofa"],
		}),
	);
	const restored = requestFromConstraints(JSON.parse(JSON.stringify(resolved)));
	expect(restored).toMatchObject({
		originalQuery,
		query: "yellow sectional",
		purpose: "replacement",
		target,
		excludeIds: ["old-sofa"],
	});
	expect(restored.minPrice).toBeUndefined();
	expect(restored.maxPrice).toBeUndefined();
});

it("cancels waiting for an uncooperative backend and distinguishes a deadline", async () => {
	const controller = new AbortController();
	const cancelled = catalogDeadline(() => new Promise(() => {}), controller.signal);
	controller.abort();
	await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
	await expect(catalogDeadline(() => new Promise(() => {}), undefined, 5)).rejects.toMatchObject({ code: "timeout" });
});

it("ranks natural language and labels retailer options separately from actual color", async () => {
	const base: CatalogProduct = {
		catalogId: "a",
		name: "A sofa",
		category: "sectional",
		color: "Ash",
		availableColors: ["Yellow"],
		imageUrl: null,
		source: null,
		imageRef: null,
		productUrl: null,
		dimensions: null,
		price: null,
		style: null,
		materials: null,
		shape: "L-shaped",
		description: null,
		reasons: [],
	};
	const catalog = createMemoryCatalogAccess([
		base,
		{ ...base, catalogId: "b", name: "Z velvet", materials: "velvet", color: "yellow" },
	]);
	const result = await catalog.search({ query: "velvet", category: "sectional sofas", color: "yellow" });
	expect(result.products.map((p) => p.catalogId)).toEqual(["b", "a"]);
	expect(result.products[0]?.reasons[0]).toBe("Actual asset color: yellow");
	expect(result.products[1]?.reasons[0]).toContain("Retailer offers yellow; actual asset color: Ash");
});

it("renders saved public S3 image references without signing and preserves literal plus keys", () => {
	const saved = {
		imageUrl: null,
		source: null,
		imageRef: "s3://livinit-storage-prod/asset_image/sofa+24/image 1.jpg",
		productUrl: null,
	} as CatalogProduct;
	const product = sanitizeCatalogProduct(saved);
	expect(product.imageUrl).toBe(
		"https://livinit-storage-prod.s3.us-east-2.amazonaws.com/asset_image/sofa%2B24/image%201.jpg",
	);
	expect(product.imageRef).toBe(saved.imageRef);
	expect(sanitizeCatalogProduct({ ...saved, imageRef: "s3://private-bucket/image.jpg" }).imageUrl).toBeNull();
});

it("matches complete brand/store names with whitespace and case normalization alongside every hard filter", async () => {
	const base: CatalogProduct = {
		catalogId: "match",
		name: "Sofa",
		source: " IKEA ",
		category: "sofa",
		color: "blue",
		price: { amountMinor: 40000, currency: "USD" },
		dimensions: { width: 2, depth: 1, height: 0.8, unit: "m" },
		imageUrl: null,
		imageRef: null,
		productUrl: null,
		style: null,
		materials: null,
		shape: null,
		availableColors: null,
		description: null,
		reasons: [],
	};
	const catalog = createMemoryCatalogAccess([
		base,
		...[
			null,
			"IKEA outlet",
			"Article",
			"Modway",
			"Modway Furniture",
			"  ACME\t\n\u00a0 Store\uFEFF ",
			"%_' OR true --",
		].map((source, i) => ({ ...base, catalogId: `source-${i}`, source })),
		{ ...base, catalogId: "wrong-category", category: "desk" },
		{ ...base, catalogId: "wrong-color", color: "red" },
		{ ...base, catalogId: "too-wide", dimensions: { ...base.dimensions!, width: 3 } },
		{ ...base, catalogId: "too-expensive", price: { amountMinor: 60000, currency: "USD" } },
	]);
	const result = await catalog.search({
		brand: "\tikeA\n",
		category: "sofa",
		color: "blue",
		maxWidth: 2,
		maxPrice: { amountMinor: 50000, currency: "USD" },
	});
	expect(result.products.map((p) => p.catalogId)).toEqual(["match"]);
	expect(result.products[0]?.source).toBe(" IKEA ");
	expect(requestFromConstraints(JSON.parse(JSON.stringify(result.resolvedConstraints))).brand).toBe("ikea");
	for (const [brand, id] of [
		["modway", "source-3"],
		["Modway Furniture", "source-4"],
		["acme  store", "source-5"],
		["%_' OR true --", "source-6"],
	]) {
		expect((await catalog.search({ brand })).products.map((p) => p.catalogId)).toEqual([id]);
	}
	expect((await catalog.search({ brand: "unknown" })).products).toEqual([]);
	expect(() => normalizeCatalogSearchRequest({ brand: " \t " })).toThrow(/non-empty/);
});
