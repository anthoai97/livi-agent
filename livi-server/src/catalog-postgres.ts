import { randomUUID } from "node:crypto";
import {
	type CatalogAccess,
	type CatalogDimensions,
	CatalogError,
	type CatalogProduct,
	catalogDeadline,
	catalogImageRef,
	catalogReasons,
	catalogResolvedConstraints,
	httpUrl,
	metreDimension,
	type NormalizedCatalogSearch,
	normalizeCatalogSearchRequest,
	sanitizeCatalogProduct,
} from "@livi/decorator-agent";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { assertCatalogEmbedding, type CatalogModels } from "./catalog-models.js";

const REGISTRY = "pipeline.design_asset_registry";
const SELECT_COLUMNS =
	"asset_id, name, category, description, asset_description, color, style, shape, materials, price, width, depth, height, image_url, product_url, available_colors";
const ACTIVE_REGISTRY_ROW = ["COALESCE(is_decor_item, false) = false", "COALESCE(is_deleted, false) = false"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DesignAssetRegistryRow {
	asset_id: unknown;
	name: unknown;
	category: unknown;
	description: unknown;
	asset_description: unknown;
	color: unknown;
	style: unknown;
	shape: unknown;
	materials: unknown;
	price: unknown;
	width: unknown;
	depth: unknown;
	height: unknown;
	image_url: unknown;
	product_url: unknown;
	available_colors: unknown;
}

export function parseCatalogDatabaseUrl(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		throw new Error("CATALOG_DATABASE_URL is malformed");
	}
	if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname)
		throw new Error("CATALOG_DATABASE_URL is malformed");
	return parsed;
}

export function createCatalogPool(url: URL): Pool {
	const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	const pooled = url.port === "6543" || url.hostname.includes("pooler.supabase.com");
	const config: PoolConfig = {
		connectionString: url.toString(),
		max: 4,
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
		allowExitOnIdle: true,
		statement_timeout: 8_000,
		query_timeout: 8_000,
		application_name: "livi-catalog",
		ssl: catalogTls(url, local, pooled),
		...(pooled ? {} : { options: "-c default_transaction_read_only=on" }),
	};
	const pool = new Pool(config);
	pool.on("error", () => {
		// Idle client errors must not crash the process or leak connection details.
	});
	return pool;
}

function catalogTls(url: URL, local: boolean, pooled: boolean): PoolConfig["ssl"] {
	if (local) return false;
	const mode = url.searchParams.get("sslmode");
	if (mode === "disable") return false;
	// Hosted poolers often present a chain Node cannot verify with default CAs.
	// Encrypt the session; require sslmode=verify-full for strict CA checks.
	if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };
	if (mode === "require" || mode === "no-verify" || pooled) return { rejectUnauthorized: false };
	return { rejectUnauthorized: true };
}

export function createPostgresCatalogAccess(
	pool: Pool,
	options: {
		models?: CatalogModels;
		onDebug?: (event: string, fields: Record<string, unknown>) => void;
	} = {},
): CatalogAccess {
	return {
		async search(request, signal) {
			signal?.throwIfAborted();
			const requestId = randomUUID();
			const started = Date.now();
			const debug = (event: string, fields: Record<string, unknown>) => {
				try {
					options.onDebug?.(event, { requestId, ...fields });
				} catch {
					/* Logging must not change search behavior. */
				}
			};
			const stage = async <T>(name: "embed" | "retrieve", run: () => Promise<T>): Promise<T> => {
				const start = Date.now();
				debug("catalog.stage.start", { stage: name, deadlineMs: name === "retrieve" ? 8000 : 30000 });
				try {
					const result = await run();
					debug("catalog.stage.complete", { stage: name, durationMs: Date.now() - start });
					return result;
				} catch (error) {
					debug("catalog.stage.error", {
						stage: name,
						durationMs: Date.now() - start,
						errorCode: error instanceof CatalogError ? error.code : "unexpected_error",
						diagnostic: error instanceof CatalogError ? error.diagnostic : undefined,
					});
					throw error;
				}
			};
			const normalized = normalizeCatalogSearchRequest(request);
			if (
				[normalized.minPrice, normalized.maxPrice].some((bound) => bound && bound.currency.toUpperCase() !== "USD")
			) {
				throw new CatalogError(
					"unsupported_filter",
					"Catalog prices use USD; currency conversion is not supported",
				);
			}
			const query =
				normalized.query ??
				normalized.originalQuery ??
				[normalized.color, normalized.style, normalized.material, normalized.category].filter(Boolean).join(" ");
			if (!query.trim()) throw new CatalogError("invalid_arguments", "Provide a search query or product filters");
			debug("catalog.search.start", {
				strategy: "vector",
				purpose: normalized.purpose,
				offset: normalized.offset,
				limit: normalized.limit,
				excludedCount: normalized.excludeIds.length,
				queryLength: query.length,
			});
			if (!options.models)
				throw new CatalogError("model_failed", "Catalog embedding model is not configured", { stage: "embed" });
			const models = options.models;
			const embedding = await stage("embed", async () => {
				const vector = await catalogDeadline((active) => models.embedQuery(query, active), signal);
				assertCatalogEmbedding(vector);
				return vector;
			});
			const { text, values } = searchSql(normalized, { embedding });
			const rows = await stage("retrieve", () => catalogQuery(pool, text, values, signal));
			const hasMore = rows.length > normalized.limit;
			const products = rows.slice(0, normalized.limit).map((row) => {
				const product = mapRegistryRow(row);
				if (!product)
					throw new CatalogError("query_failed", "Catalog product identity is missing", { stage: "retrieve" });
				return { ...product, reasons: catalogReasons(product, normalized) };
			});
			debug("catalog.search.complete", {
				durationMs: Date.now() - started,
				retrievedCount: rows.length,
				returnedCount: products.length,
				hasMore,
			});
			return {
				products,
				retrieval: {
					strategy: "vector",
					candidateCount: rows.length,
					candidateLimit: normalized.limit + 1,
					truncated: hasMore,
				},
				resolvedConstraints: catalogResolvedConstraints(normalized),
				pagination: {
					limit: normalized.limit,
					offset: normalized.offset,
					exhausted: !hasMore,
					nextOffset: normalized.offset + products.length,
				},
			};
		},
		async getProduct(catalogId, signal) {
			signal?.throwIfAborted();
			const id = catalogId.trim();
			if (!id || !UUID.test(id)) throw new CatalogError("not_found", "No catalog product matches that ID");
			const rows = await catalogQuery(
				pool,
				`SELECT ${SELECT_COLUMNS} FROM ${REGISTRY}
WHERE asset_id = $1::uuid
  AND ${ACTIVE_REGISTRY_ROW.join("\n  AND ")}
LIMIT 1`,
				[id],
				signal,
			);
			const product = rows[0] ? mapRegistryRow(rows[0]) : undefined;
			if (!product) throw new CatalogError("not_found", "No catalog product matches that ID");
			return product;
		},
	};
}

export function mapRegistryRow(row: DesignAssetRegistryRow): CatalogProduct | undefined {
	const catalogId = asText(row.asset_id);
	if (!catalogId) return undefined;
	const width = metreDimension(asNumber(row.width));
	const depth = metreDimension(asNumber(row.depth));
	const height = metreDimension(asNumber(row.height));
	const dimensions: CatalogDimensions | null =
		width === null && depth === null && height === null ? null : { width, depth, height, unit: "m" };
	const availableColors = asTextArray(row.available_colors);
	const description = asText(row.description) ?? asText(row.asset_description);
	const price = asNumber(row.price);
	const amountMinor = price === null ? 0 : Math.round(price * 100);
	return sanitizeCatalogProduct({
		catalogId,
		name: asText(row.name) ?? "",
		imageUrl: httpUrl(row.image_url),
		productUrl: httpUrl(row.product_url),
		imageRef: catalogImageRef(row.image_url),
		dimensions,
		price:
			price !== null && price > 0 && Number.isSafeInteger(amountMinor) && amountMinor > 0
				? { amountMinor, currency: "USD" }
				: null,
		category: asText(row.category),
		style: asText(row.style),
		color: asText(row.color),
		materials: asText(row.materials),
		shape: asText(row.shape),
		availableColors,
		description,
		reasons: [],
	});
}

export function searchSql(
	request: NormalizedCatalogSearch,
	options: { embedding: number[] },
): {
	text: string;
	values: Array<string | number | string[]>;
} {
	const values: Array<string | number | string[]> = [];
	const where: string[] = [...ACTIVE_REGISTRY_ROW];
	const add = (value: string | number | string[]) => {
		values.push(value);
		return `$${values.length}`;
	};
	if (request.categories) {
		const param = add(request.categories);
		where.push(
			`category IS NOT NULL AND btrim(category) <> '' AND (regexp_replace(lower(btrim(category)), '[ -]+', '_', 'g') = ANY(${param}::text[]) OR regexp_replace(regexp_replace(lower(btrim(category)), '[ -]+', '_', 'g'), 's$', '') = ANY(${param}::text[]))`,
		);
	}
	if (request.color) {
		const param = add(request.color.toLowerCase());
		where.push(`(${tokenPredicate("color", param)} OR ${availableColorPredicate(param)})`);
	}
	if (request.style) where.push(tokenPredicate("style", add(request.style.toLowerCase())));
	if (request.material) where.push(tokenPredicate("materials", add(request.material.toLowerCase())));
	pushDimension(where, add, "width", request.minWidth, request.maxWidth, request.exclusiveMaxWidth);
	pushDimension(where, add, "depth", request.minDepth, request.maxDepth, request.exclusiveMaxDepth);
	pushDimension(where, add, "height", request.minHeight, request.maxHeight, request.exclusiveMaxHeight);
	if (request.minPrice || request.maxPrice) {
		where.push("price IS NOT NULL AND price > 0 AND price < 'Infinity'::real");
		if (request.minPrice) where.push(`round(price::numeric * 100) >= ${add(request.minPrice.amountMinor)}`);
		if (request.maxPrice) where.push(`round(price::numeric * 100) <= ${add(request.maxPrice.amountMinor)}`);
	}
	if (request.excludeIds.length) where.push(`NOT (asset_id::text = ANY(${add(request.excludeIds)}::text[]))`);
	const vectorParam = add(JSON.stringify(options.embedding));
	const limitParam = add(request.limit + 1);
	const offsetParam = add(request.offset);
	return {
		text: `SELECT ${SELECT_COLUMNS} FROM ${REGISTRY} r
JOIN (SELECT asset_id, embedding FROM pipeline.asset_embeddings WHERE embedding IS NOT NULL) e USING(asset_id)
WHERE ${where.join(" AND ")}
ORDER BY e.embedding <=> ${vectorParam}::vector ASC, asset_id::text ASC
LIMIT ${limitParam} OFFSET ${offsetParam}`,
		values,
	};
}

function tokenPredicate(column: string, param: string): string {
	return `(${column} IS NOT NULL AND btrim(${column}) <> '' AND (
  lower(btrim(${column})) = ${param}
  OR ${param} = ANY (SELECT tok FROM regexp_split_to_table(lower(${column}), '[^a-z0-9]+') AS tok WHERE tok <> '')
))`;
}

function availableColorPredicate(param: string): string {
	return `EXISTS (
  SELECT 1 FROM unnest(COALESCE(available_colors, ARRAY[]::text[])) AS available(color)
  WHERE ${tokenPredicate("available.color", param)}
)`;
}

function pushDimension(
	where: string[],
	add: (value: number) => string,
	column: string,
	min: number | undefined,
	max: number | undefined,
	exclusiveMax = false,
): void {
	if (min === undefined && max === undefined) return;
	where.push(`${column} IS NOT NULL AND ${column} > 0`);
	if (min !== undefined) where.push(`${column} >= ${add(min)}`);
	if (max !== undefined) where.push(`${column} ${exclusiveMax ? "<" : "<="} ${add(max)}`);
}

async function catalogQuery(
	pool: Pool,
	text: string,
	values: Array<string | number | string[]>,
	signal: AbortSignal | undefined,
): Promise<DesignAssetRegistryRow[]> {
	return catalogDeadline(
		async (active) => {
			let stage: "connect" | "retrieve" = "connect";
			let client: PoolClient | undefined;
			let released = false;
			const release = () => {
				if (!client || released) return;
				released = true;
				client.release(active.aborted);
			};
			try {
				client = await pool.connect();
				active.addEventListener("abort", release, { once: true });
				active.throwIfAborted();
				stage = "retrieve";
				await client.query("SET default_transaction_read_only TO on");
				const result = await client.query<DesignAssetRegistryRow>({ text, values });
				active.throwIfAborted();
				return result.rows;
			} catch (error) {
				if (active.aborted)
					throw new CatalogError(signal?.aborted ? "cancelled" : "timeout", "Catalog request stopped");
				if (error instanceof CatalogError) throw error;
				const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
				const diagnostic = { stage, ...(/^[A-Z0-9_]{2,32}$/.test(code) ? { backendCode: code } : {}) };
				if (code === "57014") throw new CatalogError("timeout", "Catalog query timed out", diagnostic);
				if (code === "42501")
					throw new CatalogError("unauthorized", "Catalog is not authorized for this role", diagnostic);
				throw new CatalogError("query_failed", "Catalog query failed", diagnostic);
			} finally {
				active.removeEventListener("abort", release);
				release();
			}
		},
		signal,
		8_000,
	);
}

function asText(value: unknown): string | null {
	if (value == null) return null;
	const trimmed = String(value).trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function asTextArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.flatMap((entry) => {
		const text = asText(entry);
		return text ? [text] : [];
	});
	return items.length ? items : null;
}
