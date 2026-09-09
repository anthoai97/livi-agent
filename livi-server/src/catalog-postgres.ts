import {
	type CatalogAccess,
	type CatalogDimensions,
	CatalogError,
	type CatalogProduct,
	catalogDeadline,
	catalogImageRef,
	catalogResolvedConstraints,
	httpUrl,
	metreDimension,
	type NormalizedCatalogSearch,
	normalizeCatalogSearchRequest,
	sanitizeCatalogProduct,
} from "@livi/decorator-agent";
import { Pool, type PoolClient, type PoolConfig } from "pg";

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

export function createPostgresCatalogAccess(pool: Pool): CatalogAccess {
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
			const { text, values } = searchSql(normalized);
			const rows = await catalogQuery(pool, text, values, signal);
			const products = rows.flatMap((row) => {
				const product = mapRegistryRow(row);
				return product ? [product] : [];
			});
			const page = products.slice(0, normalized.limit);
			return {
				products: page.map((product) => ({
					...product,
					reasons: reasonsFor(product, normalized),
				})),
				resolvedConstraints: catalogResolvedConstraints(normalized),
				pagination: {
					limit: normalized.limit,
					offset: normalized.offset,
					exhausted: products.length <= normalized.limit,
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

export function searchSql(request: NormalizedCatalogSearch): {
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
		where.push(`category IS NOT NULL AND btrim(category) <> '' AND lower(btrim(category)) = ANY(${param}::text[])`);
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
	const roomParam = add(request.roomCategories);
	const limitParam = add(request.limit + 1);
	const offsetParam = add(request.offset);
	return {
		text: `SELECT ${SELECT_COLUMNS} FROM ${REGISTRY}
WHERE ${where.join(" AND ")}
ORDER BY
  CASE WHEN cardinality(${roomParam}::text[]) > 0 AND category IS NOT NULL AND lower(btrim(category)) = ANY(${roomParam}::text[]) THEN 0 ELSE 1 END,
  name ASC NULLS LAST,
  asset_id::text ASC
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

function reasonsFor(product: CatalogProduct, request: NormalizedCatalogSearch): string[] {
	const reasons: string[] = [];
	if (request.color) reasons.push(`Color matches ${request.color}`);
	if (request.category && product.category) reasons.push(`Category is ${product.category}`);
	if (request.style && product.style) reasons.push(`Style matches ${request.style}`);
	if (request.material && product.materials) reasons.push(`Material matches ${request.material}`);
	return reasons;
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
