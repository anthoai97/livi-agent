import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CatalogError, normalizeCatalogSearchRequest } from "@livi/decorator-agent";
import { Pool } from "pg";
import type { CatalogModels } from "../src/catalog-models.ts";
import {
	createCatalogPool,
	createPostgresCatalogAccess,
	mapRegistryRow,
	parseCatalogDatabaseUrl,
	searchSql,
} from "../src/catalog-postgres.ts";
import { startLiviServer } from "../src/server.ts";

const execFileAsync = promisify(execFile);
const models: CatalogModels = {
	embedQuery: async () => [1, ...Array<number>(767).fill(0)],
};

test("mapRegistryRow treats missing price and dimensions as unknown and keeps non-http image identity", () => {
	assert.equal(
		mapRegistryRow({
			asset_id: "11111111-1111-4111-8111-111111111111",
			name: "Zeroed sofa",
			category: "sofa",
			description: null,
			asset_description: "fallback copy",
			color: "yellow",
			style: null,
			shape: null,
			materials: null,
			price: 0,
			width: 0,
			depth: null,
			height: Number.NaN,
			image_url: "s3://bucket/sofa.png",
			product_url: "s3://bucket/product",
			available_colors: ["Yellow"],
		})?.price,
		null,
	);
	const mapped = mapRegistryRow({
		asset_id: "11111111-1111-4111-8111-111111111111",
		name: "Zeroed sofa",
		category: "sofa",
		description: null,
		asset_description: "fallback copy",
		color: "yellow",
		style: null,
		shape: null,
		materials: null,
		price: 0,
		width: 0,
		depth: null,
		height: Number.NaN,
		image_url: "s3://bucket/sofa.png",
		product_url: "https://shop.example/sofa",
		available_colors: ["Yellow"],
	});
	assert.deepEqual(mapped, {
		catalogId: "11111111-1111-4111-8111-111111111111",
		name: "Zeroed sofa",
		imageUrl: null,
		productUrl: "https://shop.example/sofa",
		imageRef: "s3://bucket/sofa.png",
		dimensions: null,
		price: null,
		category: "sofa",
		style: null,
		color: "yellow",
		materials: null,
		shape: null,
		availableColors: ["Yellow"],
		description: "fallback copy",
		reasons: [],
	});
	assert.equal(
		mapRegistryRow({
			asset_id: "",
			name: "Missing",
			category: null,
			description: null,
			asset_description: null,
			color: null,
			style: null,
			shape: null,
			materials: null,
			price: null,
			width: null,
			depth: null,
			height: null,
			image_url: null,
			product_url: null,
			available_colors: null,
		}),
		undefined,
	);
	const httpsImage = mapRegistryRow({
		asset_id: "22222222-2222-4222-8222-222222222222",
		name: "Https",
		category: "sectional_sofa",
		description: "A sofa",
		asset_description: null,
		color: null,
		style: null,
		shape: null,
		materials: null,
		price: 199,
		width: 2.1,
		depth: 1.1,
		height: 0.8,
		image_url: "https://cdn.example/sofa.jpg",
		product_url: null,
		available_colors: null,
	});
	assert.equal(httpsImage?.imageUrl, "https://cdn.example/sofa.jpg");
	assert.equal(httpsImage?.imageRef, "https://cdn.example/sofa.jpg");
	assert.deepEqual(httpsImage?.price, { amountMinor: 19900, currency: "USD" });
	assert.deepEqual(httpsImage?.dimensions, { width: 2.1, depth: 1.1, height: 0.8, unit: "m" });
	for (const [raw, expected] of [
		["499.99", 49999],
		[499.99, 49999],
		[null, null],
		[-1, null],
		[Number.NaN, null],
		[Infinity, null],
	] as const) {
		const mapped = mapRegistryRow({ asset_id: "sofa", name: "Sofa", price: raw } as Parameters<
			typeof mapRegistryRow
		>[0]);
		assert.deepEqual(mapped?.price, expected === null ? null : { amountMinor: expected, currency: "USD" });
	}
});

test("mapRegistryRow drops temporary signed URLs and keeps stable s3 refs", () => {
	const signed = mapRegistryRow({
		asset_id: "33333333-3333-4333-8333-333333333333",
		name: "Signed",
		category: "sofa",
		description: null,
		asset_description: null,
		color: null,
		style: null,
		shape: null,
		materials: null,
		price: null,
		width: null,
		depth: null,
		height: null,
		image_url:
			"https://cdn.example/object/sign/sofa.jpg?token=secret&expires=1&X-Amz-Signature=sig&X-Amz-Algorithm=AWS4",
		product_url: "https://shop.example/object/sign/buy?se=1&sig=abc",
		available_colors: null,
	});
	assert.equal(signed?.imageUrl, null);
	assert.equal(signed?.imageRef, null);
	assert.equal(signed?.productUrl, null);
	const querySigned = mapRegistryRow({
		asset_id: "44444444-4444-4444-8444-444444444444",
		name: "Query signed",
		category: "sofa",
		description: null,
		asset_description: null,
		color: null,
		style: null,
		shape: null,
		materials: null,
		price: null,
		width: null,
		depth: null,
		height: null,
		image_url: "https://cdn.example/sofa.jpg?Expires=1&Signature=secret&token=abc",
		product_url: null,
		available_colors: null,
	});
	assert.equal(querySigned?.imageUrl, null);
	assert.equal(querySigned?.imageRef, null);
	const s3 = mapRegistryRow({
		asset_id: "55555555-5555-4555-8555-555555555555",
		name: "S3",
		category: "sofa",
		description: null,
		asset_description: null,
		color: null,
		style: null,
		shape: null,
		materials: null,
		price: null,
		width: null,
		depth: null,
		height: null,
		image_url: "s3://bucket/sofa.png",
		product_url: null,
		available_colors: null,
	});
	assert.equal(s3?.imageUrl, null);
	assert.equal(s3?.imageRef, "s3://bucket/sofa.png");
});

test("search SQL parameterizes filters and excludes decor and deleted rows", () => {
	const compiled = searchSql(normalizeCatalogSearchRequest({ color: "yellow", category: "sectional", limit: 5 }), {
		embedding: [1],
	});
	assert.match(compiled.text, /pipeline\.design_asset_registry/);
	assert.match(compiled.text, /COALESCE\(is_decor_item, false\) = false/);
	assert.match(compiled.text, /COALESCE\(is_deleted, false\) = false/);
	assert.equal(compiled.text.includes("yellow"), false);
	assert.deepEqual(compiled.values[0], ["sectional", "sectional_sofa"]);
	assert.equal(compiled.values[1], "yellow");
	assert.match(compiled.text, /\$1/);
	assert.match(compiled.text, /\$2/);
	const exclusive = searchSql(
		normalizeCatalogSearchRequest({ category: "desk", maxWidth: 1.2, exclusiveMaxWidth: true }),
		{ embedding: [1] },
	);
	assert.match(exclusive.text, /width < \$/);
	assert.match(compiled.text, /JOIN.*asset_embeddings/);
	assert.match(compiled.text, /embedding IS NOT NULL/);
	assert.match(compiled.text, /<=>.*ASC/);
	assert.match(compiled.text, /LIMIT \$\d+ OFFSET \$\d+/);
	assert.deepEqual(compiled.values.slice(-2), [6, 0]);
	assert.doesNotMatch(compiled.text, /NOT EXISTS|concat_ws|name ASC/);
});

test("malformed catalog URLs fail closed and local pools do not use TLS", async () => {
	assert.throws(() => parseCatalogDatabaseUrl("not-a-url"), /malformed/);
	assert.throws(() => parseCatalogDatabaseUrl("https://example.com/db"), /malformed/);
	assert.throws(() => parseCatalogDatabaseUrl("postgres://"), /malformed/);
	const local = createCatalogPool(parseCatalogDatabaseUrl("postgres://127.0.0.1:1/db"));
	assert.equal(local.options.ssl, false);
	await local.end();
	assert.equal(local.ended, true);
	const hosted = createCatalogPool(parseCatalogDatabaseUrl("postgres://db.example.internal:5432/postgres"));
	assert.deepEqual(hosted.options.ssl, { rejectUnauthorized: true });
	await hosted.end();
	const pooled = createCatalogPool(
		parseCatalogDatabaseUrl("postgres://user.project@db.pooler.supabase.com:6543/postgres"),
	);
	assert.deepEqual(pooled.options.ssl, { rejectUnauthorized: false });
	await pooled.end();
	const verified = createCatalogPool(
		parseCatalogDatabaseUrl("postgres://db.example.internal:5432/postgres?sslmode=verify-full"),
	);
	assert.deepEqual(verified.options.ssl, { rejectUnauthorized: true });
	await verified.end();
});

test("absent catalog URL starts the server; malformed URL fails startup", async (t) => {
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-catalog-config-"));
	t.after(() => rm(dataDirectory, { recursive: true, force: true }));
	const server = await startLiviServer({ dataDirectory, port: 0 });
	assert.ok(server.port > 0);
	await server.close();
	await assert.rejects(
		startLiviServer({ dataDirectory, port: 0, catalogDatabaseUrl: "mysql://localhost/db" }),
		/malformed/,
	);
});

test("server.close ends the catalog pool after a configured URL", async (t) => {
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-catalog-pool-"));
	t.after(() => rm(dataDirectory, { recursive: true, force: true }));
	const server = await startLiviServer({
		dataDirectory,
		port: 0,
		catalogDatabaseUrl: "postgres://127.0.0.1:1/db",
	});
	await server.close();
});

test("price bounds reject currencies other than the USD catalog default", async () => {
	const pool = createCatalogPool(parseCatalogDatabaseUrl("postgres://127.0.0.1:1/db"));
	try {
		const catalog = createPostgresCatalogAccess(pool);
		await assert.rejects(
			catalog.search({
				color: "yellow",
				category: "sectional",
				maxPrice: { amountMinor: 50000, currency: "EUR" },
			}),
			(error: unknown) =>
				error instanceof CatalogError && error.code === "unsupported_filter" && /USD/i.test(error.message),
		);
	} finally {
		await pool.end();
	}
});

test(
	"postgres metadata hydration and restricted read permissions work without pgvector",
	{ timeout: 60_000 },
	async (t) => {
		const cluster = await startDisposablePostgres();
		if (!cluster) {
			t.skip("No disposable Postgres (initdb temp cluster failed)");
			return;
		}
		t.after(() => cluster.stop());
		await setupRegistry(cluster.adminUrl);
		const readPool = createCatalogPool(parseCatalogDatabaseUrl(cluster.readUrl));
		t.after(() => readPool.end());
		const access = createPostgresCatalogAccess(readPool, { models });
		const detail = await access.getProduct("11111111-1111-4111-8111-111111111111");
		assert.equal(detail.name, "Haven Yellow Sectional Sofa");
		assert.equal(detail.imageUrl, null);
		assert.equal(detail.imageRef, "s3://bucket/haven.png");
		assert.equal(detail.price, null);
		const priced = await access.getProduct("33333333-3333-4333-8333-333333333333");
		assert.deepEqual(priced.price, { amountMinor: 120000, currency: "USD" });
		assert.equal(priced.imageUrl, "https://cdn.example/bend.jpg");
		await assert.rejects(access.getProduct("99999999-9999-4999-8999-999999999999"), /not_found/);
		await assert.rejects(
			readPool.query("INSERT INTO pipeline.pipeline_assets (asset_id, name) VALUES ($1, $2)", [
				"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				"should-fail",
			]),
		);
		await assert.rejects(readPool.query("UPDATE pipeline.pipeline_assets SET name = $1", ["nope"]));
		await assert.rejects(readPool.query("DELETE FROM pipeline.pipeline_assets"));
	},
);

interface DisposablePostgres {
	adminUrl: string;
	readUrl: string;
	stop: () => Promise<void>;
}

async function startDisposablePostgres(): Promise<DisposablePostgres | undefined> {
	return startInitdbCluster();
}

async function startInitdbCluster(): Promise<DisposablePostgres | undefined> {
	try {
		await execFileAsync("initdb", ["--version"]);
	} catch {
		return undefined;
	}
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-pg-data-"));
	try {
		await execFileAsync("initdb", [
			"-D",
			dataDirectory,
			"-A",
			"trust",
			"-U",
			"postgres",
			"--no-locale",
			"--encoding=UTF8",
			"--no-instructions",
		]);
	} catch {
		await rm(dataDirectory, { recursive: true, force: true });
		return undefined;
	}
	const port = await freePort();
	const child = spawn(
		"postgres",
		[
			"-D",
			dataDirectory,
			"-p",
			String(port),
			"-c",
			`unix_socket_directories=${dataDirectory}`,
			"-c",
			"listen_addresses=127.0.0.1",
		],
		{ stdio: "ignore" },
	);
	const ready = Date.now() + 15_000;
	while (Date.now() < ready) {
		try {
			await execFileAsync(
				"psql",
				["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"],
				{
					timeout: 1000,
				},
			);
			break;
		} catch {
			await new Promise((done) => setTimeout(done, 150));
		}
		if (child.exitCode !== null) {
			await rm(dataDirectory, { recursive: true, force: true });
			return undefined;
		}
	}
	if (Date.now() >= ready) {
		child.kill("SIGTERM");
		await rm(dataDirectory, { recursive: true, force: true });
		return undefined;
	}
	return {
		adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
		readUrl: `postgres://livi_catalog_read@127.0.0.1:${port}/postgres`,
		stop: async () => {
			try {
				await execFileAsync("pg_ctl", ["-D", dataDirectory, "stop", "-m", "fast", "-w"], { timeout: 10_000 });
			} catch {
				child.kill("SIGTERM");
			}
			await rm(dataDirectory, { recursive: true, force: true });
		},
	};
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Missing port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
		server.on("error", reject);
	});
}

async function setupRegistry(adminUrl: string): Promise<void> {
	const pool = new Pool({ connectionString: parseCatalogDatabaseUrl(adminUrl).toString(), max: 1 });
	try {
		await pool.query("CREATE ROLE livi_catalog_read LOGIN");
		await pool.query("CREATE SCHEMA pipeline");
		await pool.query(`
CREATE TABLE pipeline.pipeline_assets (
  asset_id uuid PRIMARY KEY,
  name text,
  category text,
  description text,
  asset_description text,
  color text,
  style text,
  shape text,
  materials text,
  price real,
  width real,
  depth real,
  height real,
  image_url text,
  product_url text,
  available_colors text[],
  is_deleted bool DEFAULT false
)`);
		await pool.query(`
CREATE TABLE pipeline.decor_items (
  asset_id uuid PRIMARY KEY,
  name text,
  category text,
  description text,
  asset_description text,
  color text,
  style text,
  shape text,
  materials text,
  price real,
  width real,
  depth real,
  height real,
  image_url text,
  product_url text,
  available_colors text[],
  is_deleted bool DEFAULT false
)`);
		const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
		const invoker = Number(version.rows[0]?.server_version_num) >= 150000 ? "WITH (security_invoker = true) " : "";
		await pool.query(`
CREATE VIEW pipeline.design_asset_registry
${invoker}AS
SELECT asset_id, NULL::text AS legacy_uid, name, category, description, asset_description, color, style, shape, materials,
       price, width, depth, height, image_url, product_url, available_colors, is_deleted, false AS is_decor_item,
       false AS model_missing, 'assets'::text AS registry_source, NOW() AS inserted_at
FROM pipeline.pipeline_assets
UNION ALL
SELECT asset_id, NULL::text, name, category, description, asset_description, color, style, shape, materials,
       price, width, depth, height, image_url, product_url, available_colors, is_deleted, true, false, 'decor', NOW()
FROM pipeline.decor_items`);
		await pool.query(
			`INSERT INTO pipeline.pipeline_assets
(asset_id, name, category, color, shape, price, width, depth, height, image_url, product_url, available_colors, is_deleted)
VALUES
($1, 'Haven Yellow Sectional Sofa', 'sectional_sofa', 'yellow', NULL, 0, 2.8, 1.6, 0.9, 's3://bucket/haven.png', 'https://shop.example/haven', ARRAY['yellow'], false),
($2, 'Cove Yellow Sectional', 'sectional', 'Yellow', NULL, NULL, 2.4, 1.4, 0.8, 'https://cdn.example/cove.jpg', NULL, ARRAY['yellow'], false),
($3, 'Bend Yellow L-Shaped Sectional', 'sectional_sofa', 'yellow', 'L-shaped', 1200, 3.1, 2.0, 0.9, 'https://cdn.example/bend.jpg', NULL, NULL, false),
($4, 'Yellow Sofa', 'sofa', 'yellow', NULL, 200, 2.0, 0.9, 0.8, NULL, NULL, NULL, false),
($5, 'Navy Sectional', 'sectional', 'navy', NULL, 400, 2.5, 1.5, 0.9, NULL, NULL, NULL, false)`,
			[
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222",
				"33333333-3333-4333-8333-333333333333",
				"44444444-4444-4444-8444-444444444444",
				"55555555-5555-4555-8555-555555555555",
			],
		);
		await pool.query(
			`INSERT INTO pipeline.decor_items
(asset_id, name, category, color, price, image_url, product_url, is_deleted)
VALUES ($1, 'Yellow plant', 'sectional', 'yellow', 0, NULL, NULL, false)`,
			["66666666-6666-4666-8666-666666666666"],
		);
		await pool.query(`INSERT INTO pipeline.pipeline_assets (asset_id, name, category, materials)
SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
CASE WHEN n = 85 THEN 'Velvet desk' ELSE 'A desk ' || n END, 'desk', CASE WHEN n = 85 THEN 'velvet' ELSE 'wood' END
FROM generate_series(1,85) AS n`);
		await pool.query("GRANT CONNECT ON DATABASE postgres TO livi_catalog_read");
		await pool.query("GRANT USAGE ON SCHEMA pipeline TO livi_catalog_read");
		await pool.query(
			"GRANT SELECT ON pipeline.design_asset_registry, pipeline.pipeline_assets, pipeline.decor_items TO livi_catalog_read",
		);
		await pool.query(
			"REVOKE INSERT, UPDATE, DELETE ON pipeline.pipeline_assets, pipeline.decor_items FROM livi_catalog_read",
		);
	} finally {
		await pool.end();
	}
}

test(
	"pgvector filters and hydrates indexed products without supplementing unindexed rows",
	{ timeout: 60_000 },
	async (t) => {
		const cluster = await startDisposablePostgres();
		if (!cluster) return t.skip("No disposable PostgreSQL available");
		t.after(() => cluster.stop());
		await setupRegistry(cluster.adminUrl);
		const admin = new Pool({ connectionString: cluster.adminUrl });
		t.after(() => admin.end());
		try {
			await admin.query("CREATE EXTENSION vector");
		} catch {
			return t.skip(
				"pgvector extension is not installed in disposable PostgreSQL; live read-only vector smoke required",
			);
		}
		await admin.query("CREATE TABLE pipeline.asset_embeddings (asset_id uuid PRIMARY KEY, embedding vector(768))");
		const embedding = [1, ...Array<number>(767).fill(0)];
		await admin.query("INSERT INTO pipeline.asset_embeddings VALUES ($1, $2::vector)", [
			"11111111-1111-4111-8111-111111111111",
			JSON.stringify(embedding),
		]);
		await admin.query("GRANT SELECT ON pipeline.asset_embeddings TO livi_catalog_read");
		const readPool = createCatalogPool(parseCatalogDatabaseUrl(cluster.readUrl));
		t.after(() => readPool.end());
		let calls = 0;
		const access = createPostgresCatalogAccess(readPool, {
			models: {
				...models,
				embedQuery: async () => {
					calls++;
					return embedding;
				},
			},
		});
		const scoped = await access.search({
			category: "sectional",
			color: "yellow",
			query: "yellow",
			room: { categories: ["sofa"] },
		});
		assert.equal(calls, 1);
		assert.equal(scoped.retrieval?.strategy, "vector");
		assert.deepEqual(
			scoped.products.map((p) => p.catalogId),
			["11111111-1111-4111-8111-111111111111"],
		);
		const broad = await access.search({ query: "yellow sectional", color: "yellow" });
		assert.equal(calls, 2);
		assert.equal(broad.retrieval?.strategy, "vector");
		assert.equal(broad.products.length, 1);
		const missing = await access.search({ color: "purple", category: "sectional" });
		assert.deepEqual(missing.products, []);
		await admin.query("INSERT INTO pipeline.asset_embeddings VALUES ($1, $2::vector)", [
			"33333333-3333-4333-8333-333333333333",
			JSON.stringify(embedding),
		]);
		const priced = await access.search({
			category: "sectional",
			minPrice: { amountMinor: 120000, currency: "USD" },
			maxPrice: { amountMinor: 120000, currency: "USD" },
		});
		assert.deepEqual(
			priced.products.map((p) => p.name),
			["Bend Yellow L-Shaped Sectional"],
		);
		assert.deepEqual(priced.products[0]?.price, { amountMinor: 120000, currency: "USD" });
		assert.deepEqual(
			(await access.search({ category: "sectional", maxPrice: { amountMinor: 119999, currency: "USD" } })).products,
			[],
		);
	},
);

test("broad search model errors never become an empty successful search", async () => {
	const pool = createCatalogPool(parseCatalogDatabaseUrl("postgres://127.0.0.1:1/db"));
	try {
		await assert.rejects(createPostgresCatalogAccess(pool).search({ query: "a cozy room" }), /model_failed/);
		await assert.rejects(
			createPostgresCatalogAccess(pool, { models: { ...models, embedQuery: async () => [1, 2] } }).search({
				query: "a cozy room",
			}),
			/model_failed/,
		);
	} finally {
		await pool.end();
	}
});
