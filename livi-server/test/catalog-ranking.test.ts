import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GenerateContentResponse } from "@google/genai";
import { type CatalogProduct, normalizeCatalogSearchRequest } from "@livi/decorator-agent";
import { Client, Pool } from "pg";
import { type CatalogModels, createCatalogModels, validateCatalogAssessments } from "../src/catalog-models.ts";
import { createPostgresCatalogAccess, type DesignAssetRegistryRow, mapRegistryRow } from "../src/catalog-postgres.ts";

function row(id: number, prefix = "Product"): DesignAssetRegistryRow {
	return {
		asset_id: `${prefix}-${id}`,
		name: `${prefix} ${id}`,
		category: "sectional",
		description: "A cozy sectional",
		asset_description: null,
		color: "Ash",
		available_colors: ["yellow"],
		shape: "L-shaped",
		style: "modern",
		materials: "velvet",
		price: null,
		width: 2,
		depth: 1,
		height: 1,
		image_url: null,
		product_url: null,
	};
}
const accept: CatalogModels["validateCandidates"] = async (products) =>
	products.map((p) => ({
		catalogId: p.catalogId,
		matches: true,
		score: 50,
		evidence: [{ field: "name", quote: p.name }],
	}));

function fixture(indexed: DesignAssetRegistryRow[], unindexed: DesignAssetRegistryRow[] = []) {
	const sql: string[] = [];
	const pool = new Pool();
	const client = Object.assign(new Client(), { release: () => {} });
	mock.method(pool, "connect", async () => client);
	mock.method(client, "query", async (query: string | { text: string; values: unknown[] }) => {
		if (typeof query === "string") return { rows: [] };
		sql.push(query.text);
		const excluded = query.values.filter((value): value is string[] => Array.isArray(value)).flat();
		const source = query.text.includes("NOT EXISTS") ? unindexed : indexed;
		return { rows: source.filter((r) => !excluded.includes(String(r.asset_id))).slice(0, 81) };
	});
	return { pool, sql };
}

test("validator sees all 80 candidates before selecting eight; rejected batches advance", async () => {
	const { pool } = fixture(Array.from({ length: 81 }, (_, i) => row(i)));
	let examined = 0;
	const access = createPostgresCatalogAccess(pool, {
		models: {
			embedQuery: async () => {
				throw new Error("Category retrieval must bypass embedding");
			},
			validateCandidates: async (products) => {
				examined = products.length;
				return (await accept(products, normalizeCatalogSearchRequest({}))).map((v) => ({
					...v,
					matches: v.catalogId === "Product-80",
				}));
			},
		},
	});
	const first = await access.search({ category: "sectional", query: "yellow", purpose: "replacement" });
	assert.equal(examined, 80);
	assert.equal(first.products.length, 0);
	assert.equal(first.pagination.exhausted, false);
	assert.equal(first.pagination.excludeIds?.length, 80);
	const next = await access.search({
		category: "sectional",
		query: "yellow",
		purpose: "replacement",
		excludeIds: first.pagination.excludeIds,
	});
	assert.equal(next.products[0]?.catalogId, "Product-80");
	assert.equal(next.pagination.exhausted, true);
});

test("broad offset80 keeps unindexed candidates and category boundary reports nextOffset", async () => {
	const { pool, sql } = fixture(
		Array.from({ length: 81 }, (_, i) => row(i, "A")),
		Array.from({ length: 80 }, (_, i) => row(i, "B")),
	);
	const access = createPostgresCatalogAccess(pool, {
		models: { embedQuery: async () => [1, ...Array<number>(767).fill(0)], validateCandidates: accept },
	});
	const broad = await access.search({ query: "cozy", offset: 80 });
	assert.equal(broad.products.length, 8);
	assert.ok(broad.products.every((p) => p.catalogId.startsWith("B")));
	assert.equal(broad.pagination.nextOffset, 88);
	assert.ok(sql.every((query) => !query.includes("OFFSET")));
	const boundary = await access.search({ category: "sectional", offset: 78 });
	assert.equal(boundary.products.length, 2);
	assert.equal(boundary.pagination.nextOffset, 80);
	assert.equal(boundary.pagination.exhausted, false);
	await assert.rejects(access.search({ category: "sectional", offset: 80 }), /show_more/);
});

test("ranking may choose candidate80; unseen accepted products remain available", async () => {
	const { pool } = fixture(Array.from({ length: 80 }, (_, i) => row(i)));
	const access = createPostgresCatalogAccess(pool, {
		models: {
			embedQuery: async () => [],
			validateCandidates: async (products, request) =>
				(await accept(products, request)).map((v) => ({ ...v, score: v.catalogId === "Product-79" ? 100 : 50 })),
		},
	});
	const first = await access.search({ category: "sectional" });
	assert.equal(first.products.length, 8);
	assert.equal(first.products[0]?.catalogId, "Product-79");
	assert.deepEqual(first.pagination.excludeIds, []);
	const second = await access.search({ category: "sectional", excludeIds: first.products.map((p) => p.catalogId) });
	assert.equal(second.products.length, 8);
	assert.ok(second.products.every((p) => !first.products.some((prior) => p.catalogId === prior.catalogId)));
});

test("malformed, fabricated, omitted and duplicate model verdicts fail instead of returning empty", async () => {
	const product = mapRegistryRow(row(1))!;
	const valid = (await accept([product], normalizeCatalogSearchRequest({})))[0]!;
	for (const verdicts of [
		null,
		[],
		[valid, valid],
		[{ ...valid, catalogId: "invented" }],
		[{ ...valid, score: Number.NaN }],
		[{ ...valid, evidence: [{ field: "color", quote: "Yellow" }] }],
		[{ ...valid, evidence: [] }],
	])
		assert.throws(() => validateCatalogAssessments(verdicts, [product]), /model_failed/);
	const { pool } = fixture([row(1)]);
	const access = createPostgresCatalogAccess(pool, {
		models: {
			embedQuery: async () => [],
			validateCandidates: async () => {
				throw new Error("secret provider payload");
			},
		},
	});
	await assert.rejects(
		access.search({ category: "sectional" }),
		(error: unknown) =>
			error instanceof Error && /model_failed/.test(error.message) && !error.message.includes("secret"),
	);
});

test("Google adapter sends bounded synthetic facts, exact embedding prefix and propagates cancellation", async () => {
	const product: CatalogProduct = mapRegistryRow(row(1))!;
	const verdicts = await accept([product], normalizeCatalogSearchRequest({}));
	let validated = false;
	const models = createCatalogModels({
		client: {
			embedContent: async (args) => {
				assert.equal(args.model, "gemini-embedding-2-preview");
				assert.equal(args.contents, "task: search result | query: cozy");
				assert.equal(args.config?.outputDimensionality, 768);
				return { embeddings: [{ values: [1, ...Array<number>(767).fill(0)] }] };
			},
			generateContent: async (args) => {
				validated = true;
				assert.match(String(args.contents), /originalQuery/);
				assert.doesNotMatch(String(args.contents), /imageUrl|productUrl/);
				const response = new GenerateContentResponse();
				response.candidates = [{ content: { parts: [{ text: JSON.stringify(verdicts) }] } }];
				return response;
			},
		},
	});
	assert.equal((await models.embedQuery("cozy")).length, 768);
	assert.deepEqual(
		await models.validateCandidates([product], normalizeCatalogSearchRequest({ originalQuery: "yellow sectional" })),
		verdicts,
	);
	assert.equal(validated, true);
	validated = false;
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		models.validateCandidates([product], normalizeCatalogSearchRequest({}), controller.signal),
		/cancelled/,
	);
	assert.equal(validated, false);
});
