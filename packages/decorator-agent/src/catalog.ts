export const DEFAULT_CATALOG_LIMIT = 8;
export const MAX_CATALOG_LIMIT = 20;

export type CatalogErrorCode =
	| "catalog_unavailable"
	| "not_found"
	| "invalid_arguments"
	| "unsupported_filter"
	| "timeout"
	| "unauthorized"
	| "query_failed";

export class CatalogError extends Error {
	readonly code: CatalogErrorCode;
	constructor(code: CatalogErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "CatalogError";
		this.code = code;
	}
}

export interface CatalogMoney {
	amountMinor: number;
	currency: string;
}

/** Source width/depth/height are treated as metres when finite and greater than zero. Unknown facts are null, never 0. */
export interface CatalogDimensions {
	width: number | null;
	depth: number | null;
	height: number | null;
	unit: "m";
}

export interface CatalogProduct {
	catalogId: string;
	name: string;
	imageUrl: string | null;
	productUrl: string | null;
	/** Original registry image reference for a later resolver. Not a browser card URL when not http(s). */
	imageSource: string | null;
	dimensions: CatalogDimensions | null;
	price: CatalogMoney | null;
	category: string | null;
	style: string | null;
	color: string | null;
	materials: string | null;
	shape: string | null;
	availableColors: string[] | null;
	description: string | null;
	reasons: string[];
}

export interface CatalogPagination {
	limit: number;
	offset: number;
	exhausted: boolean;
}

export interface CatalogResolvedConstraints {
	category?: string[];
	color?: string;
	style?: string;
	material?: string;
	minWidth?: number;
	maxWidth?: number;
	minDepth?: number;
	maxDepth?: number;
	minHeight?: number;
	maxHeight?: number;
	minPrice?: CatalogMoney;
	maxPrice?: CatalogMoney;
	query?: string;
	excludeIds?: string[];
}

export interface CatalogRoomHint {
	categories: string[];
}

export interface CatalogSearchRequest {
	query?: string;
	category?: string;
	color?: string;
	style?: string;
	material?: string;
	minWidth?: number;
	maxWidth?: number;
	minDepth?: number;
	maxDepth?: number;
	minHeight?: number;
	maxHeight?: number;
	minPrice?: CatalogMoney;
	maxPrice?: CatalogMoney;
	limit?: number;
	offset?: number;
	excludeIds?: string[];
	room?: CatalogRoomHint;
}

export interface CatalogSearchResult {
	products: CatalogProduct[];
	resolvedConstraints: CatalogResolvedConstraints;
	pagination: CatalogPagination;
}

export interface CatalogDetailResult {
	product: CatalogProduct;
}

export interface CatalogAccess {
	search(request: CatalogSearchRequest, signal?: AbortSignal): Promise<CatalogSearchResult>;
	getProduct(catalogId: string, signal?: AbortSignal): Promise<CatalogProduct>;
}

export interface NormalizedCatalogSearch {
	query: string | undefined;
	category: string | undefined;
	categories: string[] | undefined;
	color: string | undefined;
	style: string | undefined;
	material: string | undefined;
	minWidth: number | undefined;
	maxWidth: number | undefined;
	minDepth: number | undefined;
	maxDepth: number | undefined;
	minHeight: number | undefined;
	maxHeight: number | undefined;
	minPrice: CatalogMoney | undefined;
	maxPrice: CatalogMoney | undefined;
	limit: number;
	offset: number;
	excludeIds: string[];
	roomCategories: string[];
}

const SECTIONAL_CATEGORIES = ["sectional", "sectional_sofa"];

export function equivalentCategories(category: string): string[] {
	const key = category.trim().toLowerCase();
	if (key === "sectional" || key === "sectional_sofa") return [...SECTIONAL_CATEGORIES];
	return [key];
}

export function metreDimension(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function httpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
	} catch {
		return null;
	}
}

export function imageSource(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function unavailableCatalogAccess(): CatalogAccess {
	const unavailable = () => {
		throw new CatalogError("catalog_unavailable", "Catalog is not configured");
	};
	return { search: unavailable, getProduct: unavailable };
}

export function createMemoryCatalogAccess(products: CatalogProduct[]): CatalogAccess {
	const records = products.map((product) => ({ ...product, reasons: [] as string[] }));
	return {
		async search(request, signal) {
			signal?.throwIfAborted();
			const normalized = normalizeCatalogSearchRequest(request);
			const matches = records.filter((product) => catalogProductMatches(product, normalized));
			matches.sort((left, right) => compareCatalogProducts(left, right, normalized));
			const page = matches.slice(normalized.offset, normalized.offset + normalized.limit);
			return {
				products: page.map((product) => ({ ...product, reasons: catalogReasons(product, normalized) })),
				resolvedConstraints: catalogResolvedConstraints(normalized),
				pagination: {
					limit: normalized.limit,
					offset: normalized.offset,
					exhausted: normalized.offset + page.length >= matches.length,
				},
			};
		},
		async getProduct(catalogId, signal) {
			signal?.throwIfAborted();
			const id = requiredId(catalogId, "catalogId");
			const product = records.find((entry) => entry.catalogId === id);
			if (!product) throw new CatalogError("not_found", "No catalog product matches that ID");
			return { ...product, reasons: [] };
		},
	};
}

export function normalizeCatalogSearchRequest(request: CatalogSearchRequest): NormalizedCatalogSearch {
	const query = optionalText(request.query);
	const category = optionalText(request.category);
	const color = optionalText(request.color);
	const style = optionalText(request.style);
	const material = optionalText(request.material);
	const minWidth = optionalPositive(request.minWidth, "minWidth");
	const maxWidth = optionalPositive(request.maxWidth, "maxWidth");
	const minDepth = optionalPositive(request.minDepth, "minDepth");
	const maxDepth = optionalPositive(request.maxDepth, "maxDepth");
	const minHeight = optionalPositive(request.minHeight, "minHeight");
	const maxHeight = optionalPositive(request.maxHeight, "maxHeight");
	assertRange(minWidth, maxWidth, "width");
	assertRange(minDepth, maxDepth, "depth");
	assertRange(minHeight, maxHeight, "height");
	const minPrice = optionalMoney(request.minPrice, "minPrice");
	const maxPrice = optionalMoney(request.maxPrice, "maxPrice");
	if (minPrice && maxPrice && minPrice.currency.toUpperCase() !== maxPrice.currency.toUpperCase())
		throw new CatalogError("unsupported_filter", "Price bounds require one verified currency");
	if (minPrice && maxPrice && minPrice.amountMinor > maxPrice.amountMinor)
		throw new CatalogError("invalid_arguments", "minPrice cannot exceed maxPrice");
	const limit = request.limit === undefined ? DEFAULT_CATALOG_LIMIT : optionalLimit(request.limit);
	const offset = request.offset === undefined ? 0 : optionalOffset(request.offset);
	const excludeIds = (request.excludeIds ?? []).map((id) => requiredId(id, "excludeIds"));
	const roomCategories = (request.room?.categories ?? []).flatMap((entry) => equivalentCategories(entry));
	return {
		query,
		category,
		categories: category ? equivalentCategories(category) : undefined,
		color,
		style,
		material,
		minWidth,
		maxWidth,
		minDepth,
		maxDepth,
		minHeight,
		maxHeight,
		minPrice,
		maxPrice,
		limit,
		offset,
		excludeIds,
		roomCategories,
	};
}

export function catalogProductMatches(product: CatalogProduct, request: NormalizedCatalogSearch): boolean {
	if (request.excludeIds.includes(product.catalogId)) return false;
	if (request.categories) {
		const category = product.category?.trim().toLowerCase();
		if (!category || !request.categories.includes(category)) return false;
	}
	if (request.color && !tokenMatches([product.color, ...(product.availableColors ?? [])], request.color)) return false;
	if (request.style && !tokenMatches([product.style], request.style)) return false;
	if (request.material && !tokenMatches([product.materials], request.material)) return false;
	if (!dimensionMatches(product.dimensions?.width ?? null, request.minWidth, request.maxWidth)) return false;
	if (!dimensionMatches(product.dimensions?.depth ?? null, request.minDepth, request.maxDepth)) return false;
	if (!dimensionMatches(product.dimensions?.height ?? null, request.minHeight, request.maxHeight)) return false;
	if (request.minPrice || request.maxPrice) {
		if (!product.price) return false;
		const currency = product.price.currency.trim().toUpperCase();
		if (
			request.minPrice &&
			(currency !== request.minPrice.currency.toUpperCase() ||
				product.price.amountMinor < request.minPrice.amountMinor)
		)
			return false;
		if (
			request.maxPrice &&
			(currency !== request.maxPrice.currency.toUpperCase() ||
				product.price.amountMinor > request.maxPrice.amountMinor)
		)
			return false;
	}
	return true;
}

export function catalogResolvedConstraints(request: NormalizedCatalogSearch): CatalogResolvedConstraints {
	return {
		...(request.categories ? { category: request.categories } : {}),
		...(request.color ? { color: request.color } : {}),
		...(request.style ? { style: request.style } : {}),
		...(request.material ? { material: request.material } : {}),
		...(request.minWidth !== undefined ? { minWidth: request.minWidth } : {}),
		...(request.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {}),
		...(request.minDepth !== undefined ? { minDepth: request.minDepth } : {}),
		...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
		...(request.minHeight !== undefined ? { minHeight: request.minHeight } : {}),
		...(request.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {}),
		...(request.minPrice ? { minPrice: request.minPrice } : {}),
		...(request.maxPrice ? { maxPrice: request.maxPrice } : {}),
		...(request.query ? { query: request.query } : {}),
		...(request.excludeIds.length ? { excludeIds: request.excludeIds } : {}),
	};
}

function catalogReasons(product: CatalogProduct, request: NormalizedCatalogSearch): string[] {
	const reasons: string[] = [];
	if (request.color) reasons.push(`Color matches ${request.color}`);
	if (request.category && product.category) reasons.push(`Category is ${product.category}`);
	if (request.style && product.style) reasons.push(`Style matches ${request.style}`);
	if (request.material && product.materials) reasons.push(`Material matches ${request.material}`);
	return reasons;
}

function compareCatalogProducts(left: CatalogProduct, right: CatalogProduct, request: NormalizedCatalogSearch): number {
	const room = rankRoom(right, request) - rankRoom(left, request);
	if (room) return room;
	const query = rankQuery(right, request) - rankQuery(left, request);
	if (query) return query;
	const name = left.name.localeCompare(right.name);
	return name !== 0 ? name : left.catalogId.localeCompare(right.catalogId);
}

function rankRoom(product: CatalogProduct, request: NormalizedCatalogSearch): number {
	const category = product.category?.trim().toLowerCase();
	return category && request.roomCategories.includes(category) ? 1 : 0;
}

function rankQuery(product: CatalogProduct, request: NormalizedCatalogSearch): number {
	if (!request.query) return 0;
	const needles = tokens(request.query);
	if (!needles.length) return 0;
	const haystack = tokens(
		[product.name, product.description, product.category, product.color, product.style, product.materials]
			.concat(product.shape ?? "")
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.join(" "),
	);
	return needles.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function dimensionMatches(value: number | null, min: number | undefined, max: number | undefined): boolean {
	if (min === undefined && max === undefined) return true;
	if (value === null) return false;
	if (min !== undefined && value < min) return false;
	if (max !== undefined && value > max) return false;
	return true;
}

function tokenMatches(facts: Array<string | null | undefined>, needle: string): boolean {
	const want = needle.trim().toLowerCase();
	if (!want) return false;
	const values = facts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0);
	if (!values.length) return false;
	return values.some((value) => value.trim().toLowerCase() === want || tokens(value).includes(want));
}

function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function optionalText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new CatalogError("invalid_arguments", "Filter text must be non-empty");
	return trimmed;
}

function optionalPositive(value: number | undefined, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new CatalogError("invalid_arguments", `${field} must be a finite size greater than zero metres`);
	return value;
}

function optionalLimit(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > MAX_CATALOG_LIMIT)
		throw new CatalogError("invalid_arguments", `limit must be an integer from 1 to ${MAX_CATALOG_LIMIT}`);
	return value;
}

function optionalOffset(value: number): number {
	if (!Number.isInteger(value) || value < 0)
		throw new CatalogError("invalid_arguments", "offset must be a non-negative integer");
	return value;
}

function optionalMoney(value: CatalogMoney | undefined, field: string): CatalogMoney | undefined {
	if (value === undefined) return undefined;
	const currency = value.currency.trim();
	if (!currency)
		throw new CatalogError("unsupported_filter", "Price comparisons require a verified matching currency");
	if (!Number.isInteger(value.amountMinor) || value.amountMinor < 0)
		throw new CatalogError("invalid_arguments", `${field} amountMinor must be a non-negative integer`);
	return { amountMinor: value.amountMinor, currency };
}

function assertRange(min: number | undefined, max: number | undefined, field: string): void {
	if (min !== undefined && max !== undefined && min > max)
		throw new CatalogError("invalid_arguments", `min ${field} cannot exceed max ${field}`);
}

function requiredId(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new CatalogError("invalid_arguments", `${field} must be a non-empty catalog ID`);
	return trimmed;
}
