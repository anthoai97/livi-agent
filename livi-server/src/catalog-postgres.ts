import {
	type CatalogAccess,
	type CatalogDimensions,
	CatalogError,
	type CatalogProduct,
	catalogDeadline,
	catalogImageRef,
	catalogProductMatches,
	catalogReasons,
	catalogResolvedConstraints,
	compareCatalogProducts,
	httpUrl,
	metreDimension,
	type NormalizedCatalogSearch,
	normalizeCatalogSearchRequest,
	sanitizeCatalogProduct,
} from "@livi/decorator-agent";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { CATALOG_EMBEDDING_DIMENSIONS, type CatalogModels, validateCatalogAssessments } from "./catalog-models.js";

const REGISTRY = "pipeline.design_asset_registry";
const SELECT_COLUMNS =
	"asset_id, name, category, description, asset_description, color, style, shape, materials, price, width, depth, height, image_url, product_url, available_colors";
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
		ssl: catalogTls(url, local),
		...(pooled ? {} : { options: "-c default_transaction_read_only=on" }),
	};
	const pool = new Pool(config);
	pool.on("error", () => {
		// Idle client errors must not crash the process or leak connection details.
	});
	return pool;
}

function catalogTls(url: URL, local: boolean): PoolConfig["ssl"] {
	if (local) return false;
	const mode = url.searchParams.get("sslmode");
	if (mode === "disable") return false;
	// Hosted poolers often present a chain Node cannot verify with default CAs.
	// Encrypt the session; require sslmode=verify-full for strict CA checks.
	if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };
	if (
		mode === "require" ||
		mode === "no-verify" ||
		url.port === "6543" ||
		url.hostname.includes("pooler.supabase.com")
	)
		return { rejectUnauthorized: false };
	return { rejectUnauthorized: true };
}

export function createPostgresCatalogAccess(pool: Pool, options: { models?: CatalogModels } = {}): CatalogAccess {
	return {
		async search(request, signal) {
			signal?.throwIfAborted();
			const normalized = normalizeCatalogSearchRequest(request);
			if (normalized.minPrice || normalized.maxPrice) {
				throw new CatalogError(
					"unsupported_filter",
					"Price comparisons require a verified matching currency; catalog prices have no currency in this source",
				);
			}
			const broad =
				Boolean(normalized.query ?? normalized.originalQuery) &&
				(!normalized.categories ||
					(normalized.purpose === "discovery" && !normalized.target && !normalized.roomCategories.length));
			if (normalized.offset >= (broad ? 160 : 80))
				throw new CatalogError(
					"invalid_arguments",
					"Offset is outside this bounded candidate batch; use show_more to continue",
				);
			let rows: DesignAssetRegistryRow[];
			let unindexedCount: number | undefined;
			let truncated: boolean;
			if (broad) {
				if (!options.models)
					throw new CatalogError("model_failed", "Catalog embedding model is not configured", { stage: "embed" });
				const embedding = await options.models.embedQuery(normalized.query ?? normalized.originalQuery!, signal);
				if (
					embedding.length !== CATALOG_EMBEDDING_DIMENSIONS ||
					!embedding.every(Number.isFinite) ||
					!embedding.some((value) => value !== 0)
				)
					throw new CatalogError("model_failed", "Catalog embedding response is invalid", { stage: "embed" });
				const vector = searchSql(normalized, { embedding });
				const text = searchSql(normalized, { unindexed: true });
				const [indexed, unindexed] = await Promise.all([
					catalogQuery(pool, vector.text, vector.values, signal),
					catalogQuery(pool, text.text, text.values, signal),
				]);
				unindexedCount = Math.min(unindexed.length, 80);
				truncated = indexed.length > 80 || unindexed.length > 80;
				rows = [...indexed.slice(0, 80), ...unindexed.slice(0, 80)];
			} else {
				const { text, values } = searchSql(normalized);
				rows = await catalogQuery(pool, text, values, signal);
				truncated = rows.length > 80;
				rows = rows.slice(0, 80);
			}
			const products = rows.flatMap((row) => {
				const product = mapRegistryRow(row);
				return product ? [product] : [];
			});
			const candidates = products.filter((product) => catalogProductMatches(product, normalized));
			let ranked = candidates;
			if (candidates.length) {
				if (!options.models)
					throw new CatalogError("model_failed", "Catalog validation model is not configured", {
						stage: "validate",
					});
				let verdicts: ReturnType<typeof validateCatalogAssessments>;
				try {
					verdicts = validateCatalogAssessments(
						await catalogDeadline(
							(active) => options.models!.validateCandidates(candidates, normalized, active),
							signal,
						),
						candidates,
					);
				} catch (error) {
					if (error instanceof CatalogError) throw error;
					throw new CatalogError("model_failed", "Catalog attribute validation failed", { stage: "validate" });
				}
				const byId = new Map(verdicts.map((verdict) => [verdict.catalogId, verdict]));
				ranked = candidates.filter((product) => byId.get(product.catalogId)?.matches);
				ranked.sort(
					(left, right) =>
						byId.get(right.catalogId)!.score - byId.get(left.catalogId)!.score ||
						compareCatalogProducts(left, right, normalized),
				);
			} else ranked.sort((left, right) => compareCatalogProducts(left, right, normalized));
			const page = ranked.slice(normalized.offset, normalized.offset + normalized.limit);
			return {
				products: page.map((product) => ({
					...product,
					reasons: catalogReasons(product, normalized),
				})),
				retrieval: {
					strategy: broad ? "vector_text" : normalized.categories ? "category_text" : "text",
					candidateCount: products.length,
					candidateLimit: broad ? 160 : 80,
					truncated,
					...(unindexedCount === undefined ? {} : { unindexedCount }),
				},
				resolvedConstraints: catalogResolvedConstraints(normalized),
				pagination: {
					limit: normalized.limit,
					offset: normalized.offset,
					exhausted: !truncated && normalized.offset + page.length >= ranked.length,
					nextOffset: normalized.offset + page.length,
					excludeIds: [
						...normalized.omitIds,
						...products
							.filter(
								(product) =>
									!ranked.some((entry) => entry.catalogId === product.catalogId) ||
									ranked.slice(0, normalized.offset).some((entry) => entry.catalogId === product.catalogId),
							)
							.map((product) => product.catalogId),
					],
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
  AND COALESCE(is_decor_item, false) = false
  AND COALESCE(is_deleted, false) = false
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
	return sanitizeCatalogProduct({
		catalogId,
		name: asText(row.name) ?? "",
		imageUrl: httpUrl(row.image_url),
		productUrl: httpUrl(row.product_url),
		imageRef: catalogImageRef(row.image_url),
		dimensions,
		price: null,
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
	options: { embedding?: number[]; unindexed?: boolean } = {},
): {
	text: string;
	values: Array<string | number | string[]>;
} {
	const values: Array<string | number | string[]> = [];
	const where = ["COALESCE(is_decor_item, false) = false", "COALESCE(is_deleted, false) = false"];
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
	if (request.excludeIds.length) where.push(`NOT (asset_id::text = ANY(${add(request.excludeIds)}::text[]))`);
	const queryParam = add(request.query ?? request.originalQuery ?? "");
	if (options.unindexed)
		where.push(
			`NOT EXISTS (SELECT 1 FROM pipeline.asset_embeddings e WHERE e.asset_id = r.asset_id AND e.embedding IS NOT NULL)`,
		);
	const vectorParam = options.embedding ? add(JSON.stringify(options.embedding)) : undefined;

	const roomParam = add(request.roomCategories);
	const limitParam = add(81);

	return {
		text: `SELECT ${SELECT_COLUMNS} FROM ${REGISTRY} r ${vectorParam ? "JOIN (SELECT asset_id, embedding FROM pipeline.asset_embeddings WHERE embedding IS NOT NULL) e USING(asset_id)" : ""}
WHERE ${where.join(" AND ")}
ORDER BY
  ${vectorParam ? `e.embedding <=> ${vectorParam}::vector ASC,` : ""}
  (SELECT count(*) FROM unnest(regexp_split_to_array(lower(${queryParam}::text), '[^a-z0-9]+')) AS q(token)
   WHERE length(q.token) > 2 AND q.token <> ALL(ARRAY['the','with','for','and','can','you','current','replace'])
   AND position(q.token IN lower(concat_ws(' ', name, category, description, asset_description, color, style, shape, materials))) > 0) DESC,
  CASE WHEN cardinality(${roomParam}::text[]) > 0 AND category IS NOT NULL AND lower(btrim(category)) = ANY(${roomParam}::text[]) THEN 0 ELSE 1 END,
  name ASC NULLS LAST,
  asset_id::text ASC
LIMIT ${limitParam}`,
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
  WHERE lower(btrim(available.color)) = ${param}
     OR ${param} = ANY (SELECT tok FROM regexp_split_to_table(lower(available.color), '[^a-z0-9]+') AS tok WHERE tok <> '')
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
	if (typeof value !== "string") return value == null ? null : String(value).trim() || null;
	const trimmed = value.trim();
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
