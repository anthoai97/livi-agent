import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { CatalogError } from "@livi/decorator-agent";
import { Client, Pool } from "pg";
import { createCatalogModels } from "../src/catalog-models.ts";
import { createPostgresCatalogAccess, type DesignAssetRegistryRow } from "../src/catalog-postgres.ts";

const embedding = [1, ...Array<number>(767).fill(0)];

function row(id: number): DesignAssetRegistryRow {
	return {
		asset_id: `Product-${id}`,
		name: `Product ${id}`,
		category: "sectional",
		description: "A cozy sectional",
		asset_description: null,
		color: "Ash",
		available_colors: ["yellow"],
		shape: "L-shaped",
		style: "modern",
		materials: "velvet",
		price: 499.99,
		width: 2,
		depth: 1,
		height: 1,
		image_url: null,
		product_url: null,
	};
}

function fixture(rows: DesignAssetRegistryRow[]) {
	const sql: { text: string; values: unknown[] }[] = [];
	const pool = new Pool();
	const client = Object.assign(new Client(), { release: () => {} });
	mock.method(pool, "connect", async () => client);
	mock.method(client, "query", async (query: string | { text: string; values: unknown[] }) => {
		if (typeof query === "string") return { rows: [] };
		sql.push(query);
		const excluded = query.values.filter((value): value is string[] => Array.isArray(value)).flat();
		const limit = Number(query.values.at(-2));
		const offset = Number(query.values.at(-1));
		return { rows: rows.filter((r) => !excluded.includes(String(r.asset_id))).slice(offset, offset + limit) };
	});
	return { pool, sql, client };
}

test("vector retrieval preserves database similarity order and requests only eight plus a probe", async () => {
	const rows = [row(79), ...Array.from({ length: 79 }, (_, i) => row(i))];
	const { pool, sql } = fixture(rows);
	let queries = 0;
	const access = createPostgresCatalogAccess(pool, {
		models: {
			embedQuery: async (query) => {
				queries++;
				assert.equal(query, "yellow sectional");
				return embedding;
			},
		},
	});
	const first = await access.search({ query: "yellow sectional", category: "sectional" });
	assert.equal(queries, 1);
	assert.equal(sql.length, 1);
	assert.deepEqual(sql[0]?.values.slice(-2), [9, 0]);
	assert.deepEqual(
		first.products.map((p) => p.catalogId),
		rows.slice(0, 8).map((r) => r.asset_id),
	);
	assert.deepEqual(first.products[0]?.price, { amountMinor: 49999, currency: "USD" });
	assert.deepEqual(first.retrieval, { strategy: "vector", candidateCount: 9, candidateLimit: 9, truncated: true });
	assert.deepEqual(first.pagination, { limit: 8, offset: 0, nextOffset: 8, exhausted: false });
});

test("vector pagination crosses eighty and exclusion continuation preserves an initial offset", async () => {
	const { pool } = fixture(Array.from({ length: 101 }, (_, i) => row(i)));
	const access = createPostgresCatalogAccess(pool, { models: { embedQuery: async () => embedding } });
	const boundary = await access.search({ query: "sofa", offset: 78 });
	assert.deepEqual(
		boundary.products.map((p) => p.catalogId),
		Array.from({ length: 8 }, (_, i) => `Product-${78 + i}`),
	);
	assert.equal(boundary.pagination.nextOffset, 86);
	const tail = await access.search({ query: "sofa", offset: 96 });
	assert.equal(tail.products.length, 5);
	assert.equal(tail.pagination.exhausted, true);
	const shown: string[] = [];
	let exhausted = false;
	while (!exhausted) {
		const page = await access.search({ query: "sofa", offset: 2, omitIds: shown });
		shown.push(...page.products.map((p) => p.catalogId));
		exhausted = page.pagination.exhausted;
		assert.ok(shown.length <= 99);
	}
	assert.deepEqual(
		shown,
		Array.from({ length: 99 }, (_, i) => `Product-${i + 2}`),
	);
	assert.equal(new Set(shown).size, 99);
});

test("embedding query falls back to original text or structured attributes; empty requests fail before SQL", async () => {
	const { pool, sql } = fixture([]);
	const queries: string[] = [];
	const access = createPostgresCatalogAccess(pool, {
		models: {
			embedQuery: async (query) => {
				queries.push(query);
				return embedding;
			},
		},
	});
	await access.search({ originalQuery: "a comfortable sofa" });
	await access.search({ color: "yellow", style: "modern", material: "velvet", category: "sofa" });
	assert.deepEqual(queries, ["a comfortable sofa", "yellow modern velvet sofa"]);
	assert.equal(sql.length, 2);
	await assert.rejects(access.search({}), /invalid_arguments/);
	assert.equal(sql.length, 2);
});

test("Google embedding adapter uses pipeline configuration and forwards cancellation", async () => {
	let calls = 0;
	const controller = new AbortController();
	const models = createCatalogModels({
		client: {
			embedContent: async (args) => {
				calls++;
				assert.equal(args.model, "gemini-embedding-2-preview");
				assert.equal(args.contents, "task: search result | query: cozy");
				assert.equal(args.config?.outputDimensionality, 768);
				assert.ok(args.config?.abortSignal);
				return { embeddings: [{ values: embedding }] };
			},
		},
	});
	assert.deepEqual(await models.embedQuery("cozy", controller.signal), embedding);
	controller.abort();
	await assert.rejects(models.embedQuery("cozy", controller.signal), /cancelled/);
	assert.equal(calls, 1);
});

test("invalid embedding responses and provider failures never become empty search results", async () => {
	for (const values of [[], [1, 2], Array<number>(768).fill(0), [Number.NaN, ...embedding.slice(1)]]) {
		const models = createCatalogModels({ client: { embedContent: async () => ({ embeddings: [{ values }] }) } });
		await assert.rejects(models.embedQuery("sofa"), /model_failed/);
	}
	const models = createCatalogModels({
		client: {
			embedContent: async () => {
				throw Object.assign(new Error("private-provider-marker"), { status: 429 });
			},
		},
	});
	await assert.rejects(models.embedQuery("sofa"), (error: unknown) => {
		assert.ok(error instanceof CatalogError);
		assert.equal(error.code, "model_failed");
		assert.deepEqual(error.diagnostic, { stage: "embed", backendCode: "HTTP_429" });
		assert.doesNotMatch(error.message, /private-/);
		return true;
	});
});

test("debug logs time embedding and retrieval without product facts, queries, or validation stages", async () => {
	const { pool, client } = fixture([row(1)]);
	const events: { event: string; fields: Record<string, unknown> }[] = [];
	const access = createPostgresCatalogAccess(pool, {
		onDebug: (event, fields) => events.push({ event, fields }),
		models: { embedQuery: async () => embedding },
	});
	await access.search({ query: "private-query-marker" });
	assert.deepEqual(
		events.filter(({ event }) => event === "catalog.stage.complete").map(({ fields }) => fields.stage),
		["embed", "retrieve"],
	);
	assert.equal(new Set(events.map(({ fields }) => fields.requestId)).size, 1);
	assert.doesNotMatch(JSON.stringify(events), /private-|validate|validationCount/);
	mock.method(client, "query", async () => {
		throw Object.assign(new Error("private-db-marker"), { code: "57014" });
	});
	await assert.rejects(access.search({ query: "private-query-marker" }), /timeout/);
	const failure = events.find(({ event }) => event === "catalog.stage.error")!;
	assert.equal(failure.fields.stage, "retrieve");
	assert.equal(failure.fields.errorCode, "timeout");
	assert.equal(typeof failure.fields.durationMs, "number");
	assert.doesNotMatch(JSON.stringify(events), /private-/);
	const { pool: healthy } = fixture([row(1)]);
	assert.equal(
		(
			await createPostgresCatalogAccess(healthy, {
				onDebug: () => {
					throw new Error("broken sink");
				},
				models: { embedQuery: async () => embedding },
			}).search({ category: "sectional" })
		).products.length,
		1,
	);
});
