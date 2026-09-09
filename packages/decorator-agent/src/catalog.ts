export const DEFAULT_CATALOG_LIMIT = 8;
export const MAX_CATALOG_LIMIT = 20;

export type CatalogErrorCode =
	| "catalog_unavailable"
	| "not_found"
	| "invalid_arguments"
	| "unsupported_filter"
	| "timeout"
	| "unauthorized"
	| "query_failed"
	| "model_failed"
	| "cancelled";

export class CatalogError extends Error {
	readonly code: CatalogErrorCode;
	readonly diagnostic: CatalogDiagnostic | undefined;
	constructor(code: CatalogErrorCode, message: string, diagnostic?: CatalogDiagnostic) {
		super(`${code}: ${message}`);
		this.name = "CatalogError";
		this.code = code;
		this.diagnostic = diagnostic;
	}
}

/** Safe internal metadata only; never include SQL, URLs, credentials or provider messages. */
export interface CatalogDiagnostic {
	stage: "connect" | "retrieve" | "embed";
	backendCode?: string;
}

export type CatalogSearchPurpose = "replacement" | "recommendation" | "discovery";
export interface CatalogTarget {
	designId: string;
	revision: string;
	objectId: string;
	catalogId: string | null;
	category: string;
}
export interface CatalogRetrieval {
	strategy: "vector";
	candidateCount: number;
	candidateLimit: number;
	/** A one-row lookahead found more eligible indexed products. */
	truncated: boolean;
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
	/** Stable non-browser image identity for a later resolver. Not a card URL when not http(s). */
	imageRef: string | null;
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
	/** Next offset for the same filters and exclusions. */
	nextOffset?: number;
	limit: number;
	offset: number;
	exhausted: boolean;
}

export interface CatalogResolvedConstraints {
	originalQuery?: string;
	purpose?: CatalogSearchPurpose;
	target?: CatalogTarget;
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
	exclusiveMaxWidth?: boolean;
	exclusiveMaxDepth?: boolean;
	exclusiveMaxHeight?: boolean;
}

export interface CatalogRoomHint {
	categories: string[];
}

export interface CatalogSearchRequest {
	/** Traversal only; never becomes an intentional user exclusion. */
	omitIds?: string[];
	originalQuery?: string;
	purpose?: CatalogSearchPurpose;
	target?: CatalogTarget;
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
	exclusiveMaxWidth?: boolean;
	exclusiveMaxDepth?: boolean;
	exclusiveMaxHeight?: boolean;
}

export interface CatalogSearchResult {
	retrieval?: CatalogRetrieval;
	products: CatalogProduct[];
	resolvedConstraints: CatalogResolvedConstraints;
	pagination: CatalogPagination;
}

export interface CatalogDetailResult {
	product: CatalogProduct;
}

export const CATALOG_RECOMMENDATION_KIND = "catalog_recommendations";
export type CatalogFollowUp = "show_more" | "cheaper" | "smaller";
export type CatalogDimensionName = "width" | "depth" | "height";

export interface CatalogRecommendationDetails {
	retrieval?: CatalogRetrieval;
	kind: typeof CATALOG_RECOMMENDATION_KIND;
	searchId: string;
	products: CatalogProduct[];
	resolvedConstraints: CatalogResolvedConstraints;
	pagination: CatalogPagination;
	shownIds: string[];
	binding: { designId: string } | null;
	followUp: CatalogFollowUp | null;
}

export interface CatalogAccess {
	search(request: CatalogSearchRequest, signal?: AbortSignal): Promise<CatalogSearchResult>;
	getProduct(catalogId: string, signal?: AbortSignal): Promise<CatalogProduct>;
}

export interface NormalizedCatalogSearch {
	intentionalExcludeIds: string[];
	omitIds: string[];
	originalQuery: string | undefined;
	purpose: CatalogSearchPurpose;
	target: CatalogTarget | undefined;
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
	exclusiveMaxWidth: boolean;
	exclusiveMaxDepth: boolean;
	exclusiveMaxHeight: boolean;
}

const CATEGORY_ALIASES: Record<string, string> = {
	sectional_sofa: "sectional",
	couch: "sofa",
	couches: "sofa",
	armchair: "accent_chair",
	arm_chair: "accent_chair",
	chair: "accent_chair",
	lounge_chair: "accent_chair",
	area_rug: "rug",
	carpet: "rug",
	runner: "rug",
	end_table: "side_table",
	writing_desk: "desk",
	desk_lamp: "table_lamp",
	bookshelf: "bookcase",
	bookshelves: "bookcase",
	book_shelves: "bookcase",
	shelf: "bookcase",
	shelves: "bookcase",
	benches: "bench",
	footstool: "ottoman",
	console: "media_unit",
	media_console: "media_unit",
	media_storage: "media_unit",
	entertainment_unit: "media_unit",
	tv_console: "media_unit",
	television: "tv",
	television_stand: "tv_stand",
	mirror: "wall_mirror",
	standing_mirror: "floor_mirror",
	plant: "planter",
	pub_table: "bar_table",
	storage: "storage_unit",
	storage_organizer: "storage_unit",
	storage_piece: "storage_unit",
	storage_pieces: "storage_unit",
};

export function equivalentCategories(category: string): string[] {
	const key = category.trim().toLowerCase().replace(/[ -]+/g, "_");
	const singular = key.endsWith("s") ? key.slice(0, -1) : key;
	const canonical = CATEGORY_ALIASES[key] ?? CATEGORY_ALIASES[singular] ?? singular;
	return [canonical, ...Object.keys(CATEGORY_ALIASES).filter((alias) => CATEGORY_ALIASES[alias] === canonical)];
}

export function metreDimension(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stableSourceUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || isTemporarySignedUrl(trimmed)) return null;
	return trimmed;
}

export function httpUrl(value: unknown): string | null {
	const trimmed = stableSourceUrl(value);
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
	} catch {
		return null;
	}
}

/** Stable source identity. Keeps s3:// and unsigned http(s); drops expiring signed URLs. */
export function catalogImageRef(value: unknown): string | null {
	const trimmed = stableSourceUrl(value);
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "s3:" ? trimmed : null;
	} catch {
		return null;
	}
}

export function sanitizeCatalogProduct(product: CatalogProduct): CatalogProduct {
	const imageRef = catalogImageRef(product.imageRef) ?? catalogImageRef(product.imageUrl);
	let imageUrl = httpUrl(product.imageUrl);
	// Same public bucket and region used by web-pipeline/lib/normalizeAssetUrl.ts.
	if (!imageUrl && imageRef?.startsWith("s3://livinit-storage-prod/")) {
		const source = new URL(imageRef);
		imageUrl = httpUrl(
			`https://livinit-storage-prod.s3.us-east-2.amazonaws.com${source.pathname.replace(/\+/g, "%2B")}${source.search}`,
		);
	}
	return {
		...product,
		imageUrl,
		imageRef,
		productUrl: httpUrl(product.productUrl),
	};
}

function isTemporarySignedUrl(value: string): boolean {
	if (/\/object\/sign\//i.test(value)) return true;
	try {
		const parsed = new URL(value);
		for (const key of parsed.searchParams.keys()) {
			const name = key.toLowerCase();
			if (name === "expires" || name === "se" || name === "sig" || name === "signature" || name === "token")
				return true;
			if (name.startsWith("x-amz-")) return true;
		}
		return false;
	} catch {
		return /[?&](expires|se|sig|signature|token|x-amz-[^=]*)=/i.test(value);
	}
}

export function unavailableCatalogAccess(): CatalogAccess {
	const unavailable = () => {
		throw new CatalogError("catalog_unavailable", "Catalog is not configured");
	};
	return { search: unavailable, getProduct: unavailable };
}

export function createMemoryCatalogAccess(products: CatalogProduct[]): CatalogAccess {
	const records = products.map((product) => ({ ...sanitizeCatalogProduct(product), reasons: [] as string[] }));
	return {
		async search(request, signal) {
			signal?.throwIfAborted();
			const normalized = normalizeCatalogSearchRequest(request);
			const matches = records.filter((product) => catalogProductMatches(product, normalized));
			matches.sort((left, right) => compareCatalogProducts(left, right, normalized));
			const page = matches.slice(normalized.offset, normalized.offset + normalized.limit);
			return {
				products: page.map((product) =>
					sanitizeCatalogProduct({ ...product, reasons: catalogReasons(product, normalized) }),
				),
				resolvedConstraints: catalogResolvedConstraints(normalized),
				pagination: {
					limit: normalized.limit,
					offset: normalized.offset,
					nextOffset: normalized.offset + page.length,
					exhausted: normalized.offset + page.length >= matches.length,
				},
			};
		},
		async getProduct(catalogId, signal) {
			signal?.throwIfAborted();
			const id = requiredId(catalogId, "catalogId");
			const product = records.find((entry) => entry.catalogId === id);
			if (!product) throw new CatalogError("not_found", "No catalog product matches that ID");
			return sanitizeCatalogProduct({ ...product, reasons: [] });
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
	const intentionalExcludeIds = (request.excludeIds ?? []).map((id) => requiredId(id, "excludeIds"));
	const omitIds = (request.omitIds ?? []).map((id) => requiredId(id, "omitIds"));
	const excludeIds = [...new Set([...intentionalExcludeIds, ...omitIds])];
	const roomCategories = (request.room?.categories ?? []).flatMap((entry) => equivalentCategories(entry));
	return {
		intentionalExcludeIds,
		omitIds,
		originalQuery: request.originalQuery ?? query,
		purpose: request.purpose ?? "discovery",
		target: request.target,
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
		exclusiveMaxWidth: request.exclusiveMaxWidth === true,
		exclusiveMaxDepth: request.exclusiveMaxDepth === true,
		exclusiveMaxHeight: request.exclusiveMaxHeight === true,
	};
}

export function catalogProductMatches(product: CatalogProduct, request: NormalizedCatalogSearch): boolean {
	if (request.excludeIds.includes(product.catalogId)) return false;
	if (request.categories) {
		const category = product.category ? equivalentCategories(product.category)[0] : undefined;
		if (!category || !request.categories.includes(category)) return false;
	}
	if (request.color && !tokenMatches([product.color, ...(product.availableColors ?? [])], request.color)) return false;
	if (request.style && !tokenMatches([product.style], request.style)) return false;
	if (request.material && !tokenMatches([product.materials], request.material)) return false;
	if (
		!dimensionMatches(
			product.dimensions?.width ?? null,
			request.minWidth,
			request.maxWidth,
			request.exclusiveMaxWidth,
		)
	)
		return false;
	if (
		!dimensionMatches(
			product.dimensions?.depth ?? null,
			request.minDepth,
			request.maxDepth,
			request.exclusiveMaxDepth,
		)
	)
		return false;
	if (
		!dimensionMatches(
			product.dimensions?.height ?? null,
			request.minHeight,
			request.maxHeight,
			request.exclusiveMaxHeight,
		)
	)
		return false;
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
		...(request.originalQuery ? { originalQuery: request.originalQuery } : {}),
		purpose: request.purpose,
		...(request.target ? { target: request.target } : {}),
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
		...(request.intentionalExcludeIds.length ? { excludeIds: request.intentionalExcludeIds } : {}),
		...(request.exclusiveMaxWidth ? { exclusiveMaxWidth: true } : {}),
		...(request.exclusiveMaxDepth ? { exclusiveMaxDepth: true } : {}),
		...(request.exclusiveMaxHeight ? { exclusiveMaxHeight: true } : {}),
	};
}

export function isCatalogRecommendationDetails(value: unknown): value is CatalogRecommendationDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.kind !== CATALOG_RECOMMENDATION_KIND || typeof record.searchId !== "string" || !record.searchId.trim())
		return false;
	if (!Array.isArray(record.products) || !record.products.every(isCatalogProductSnapshot)) return false;
	if (!record.resolvedConstraints || typeof record.resolvedConstraints !== "object") return false;
	if (!record.pagination || typeof record.pagination !== "object") return false;
	const pagination = record.pagination as Record<string, unknown>;
	if (
		typeof pagination.limit !== "number" ||
		typeof pagination.offset !== "number" ||
		typeof pagination.exhausted !== "boolean"
	)
		return false;
	if (!Array.isArray(record.shownIds) || !record.shownIds.every((id) => typeof id === "string" && id.length > 0))
		return false;
	if (record.binding !== null) {
		if (!record.binding || typeof record.binding !== "object") return false;
		const binding = record.binding as Record<string, unknown>;
		if (typeof binding.designId !== "string" || !binding.designId.trim()) return false;
	}
	if (
		record.followUp !== null &&
		record.followUp !== "show_more" &&
		record.followUp !== "cheaper" &&
		record.followUp !== "smaller"
	)
		return false;
	return true;
}

function isCatalogProductSnapshot(value: unknown): value is CatalogProduct {
	if (!value || typeof value !== "object") return false;
	const product = value as Record<string, unknown>;
	return typeof product.catalogId === "string" && product.catalogId.length > 0 && typeof product.name === "string";
}

export function requestFromConstraints(
	constraints: CatalogResolvedConstraints,
	room?: CatalogRoomHint,
): CatalogSearchRequest {
	return {
		originalQuery: constraints.originalQuery,
		purpose: constraints.purpose,
		target: constraints.target,
		excludeIds: constraints.excludeIds,
		query: constraints.query,
		category: constraints.category?.[0],
		color: constraints.color,
		style: constraints.style,
		material: constraints.material,
		minWidth: constraints.minWidth,
		maxWidth: constraints.maxWidth,
		minDepth: constraints.minDepth,
		maxDepth: constraints.maxDepth,
		minHeight: constraints.minHeight,
		maxHeight: constraints.maxHeight,
		minPrice: constraints.minPrice,
		maxPrice: constraints.maxPrice,
		exclusiveMaxWidth: constraints.exclusiveMaxWidth,
		exclusiveMaxDepth: constraints.exclusiveMaxDepth,
		exclusiveMaxHeight: constraints.exclusiveMaxHeight,
		room,
	};
}

export function mergeCatalogFollowUp(
	prior: CatalogRecommendationDetails,
	followUp: CatalogFollowUp,
	options: {
		referenceCatalogId?: string;
		dimension?: CatalogDimensionName;
		room?: CatalogRoomHint;
		candidates?: CatalogProduct[];
	} = {},
): { request: CatalogSearchRequest; searchId: string; shownIds: string[] } {
	const base = requestFromConstraints(prior.resolvedConstraints, options.room);
	if (followUp === "show_more") {
		return {
			request: {
				...base,
				omitIds: [...prior.shownIds],
				offset: prior.pagination.offset,
				limit: prior.pagination.limit,
			},
			searchId: prior.searchId,
			shownIds: [...prior.shownIds],
		};
	}
	const reference = pickFollowUpReference(prior, options.referenceCatalogId, options.candidates);
	if (followUp === "cheaper") {
		if (!reference.price)
			throw new CatalogError(
				"invalid_arguments",
				"Cheaper needs an identified product with a verified same-currency price",
			);
		if (
			[base.minPrice, base.maxPrice].some(
				(bound) => bound && bound.currency.toUpperCase() !== reference.price!.currency.toUpperCase(),
			)
		)
			throw new CatalogError("unsupported_filter", "Cheaper must preserve the original verified currency");
		if (reference.price.amountMinor < 1)
			throw new CatalogError("invalid_arguments", "Nothing is cheaper than the identified product's verified price");
		return {
			request: {
				...base,
				maxPrice: {
					amountMinor: Math.min(
						reference.price.amountMinor - 1,
						base.maxPrice?.amountMinor ?? Number.POSITIVE_INFINITY,
					),
					currency: reference.price.currency,
				},
				excludeIds: base.excludeIds,
				offset: 0,
				limit: prior.pagination.limit,
			},
			searchId: prior.searchId,
			shownIds: [],
		};
	}
	const dimension = options.dimension ?? uniqueKnownDimension(reference);
	if (!dimension)
		throw new CatalogError(
			"invalid_arguments",
			"Smaller needs an identified product and dimension (width, depth, or height)",
		);
	const size = reference.dimensions?.[dimension] ?? null;
	if (size === null)
		throw new CatalogError("invalid_arguments", `The identified product has no verified ${dimension}`);
	const request: CatalogSearchRequest = {
		...base,
		excludeIds: base.excludeIds,
		offset: 0,
		limit: prior.pagination.limit,
	};
	if (dimension === "width") {
		request.maxWidth = Math.min(size, base.maxWidth ?? size);
		request.exclusiveMaxWidth = size <= (base.maxWidth ?? size) || base.exclusiveMaxWidth;
	} else if (dimension === "depth") {
		request.maxDepth = Math.min(size, base.maxDepth ?? size);
		request.exclusiveMaxDepth = size <= (base.maxDepth ?? size) || base.exclusiveMaxDepth;
	} else {
		request.maxHeight = Math.min(size, base.maxHeight ?? size);
		request.exclusiveMaxHeight = size <= (base.maxHeight ?? size) || base.exclusiveMaxHeight;
	}
	return { request, searchId: prior.searchId, shownIds: [] };
}

function pickFollowUpReference(
	prior: CatalogRecommendationDetails,
	catalogId?: string,
	candidates?: CatalogProduct[],
): CatalogProduct {
	const pool = [...(candidates ?? []), ...prior.products];
	if (catalogId) {
		const match = pool.find((product) => product.catalogId === catalogId);
		if (!match) throw new CatalogError("invalid_arguments", "Identify a product from the current recommendations");
		return match;
	}
	const unique = uniqueProducts(pool);
	if (unique.length === 1) return unique[0]!;
	if (prior.products.length === 1) return prior.products[0]!;
	throw new CatalogError("invalid_arguments", "Identify which recommended product to compare");
}

function uniqueProducts(products: CatalogProduct[]): CatalogProduct[] {
	const seen = new Set<string>();
	return products.filter((product) => {
		if (seen.has(product.catalogId)) return false;
		seen.add(product.catalogId);
		return true;
	});
}

function uniqueKnownDimension(product: CatalogProduct): CatalogDimensionName | undefined {
	const known = (["width", "depth", "height"] as const).filter((field) => product.dimensions?.[field] != null);
	return known.length === 1 ? known[0] : undefined;
}

export function catalogReasons(product: CatalogProduct, request: NormalizedCatalogSearch): string[] {
	const reasons: string[] = [];
	if (request.color)
		reasons.push(
			tokenMatches([product.color], request.color)
				? `Actual asset color: ${product.color}`
				: `Retailer offers ${request.color}; actual asset color: ${product.color ?? "unknown"}. Variant not verified for this asset.`,
		);
	if (!request.color && (product.color || product.availableColors?.length))
		reasons.push(
			`Actual asset color: ${product.color ?? "unknown"}${product.availableColors?.length ? `; retailer options: ${product.availableColors.join(", ")} (variants unverified)` : ""}`,
		);
	if (request.category && product.category) reasons.push(`Category is ${product.category}`);
	if (request.style && product.style) reasons.push(`Style matches ${request.style}`);
	if (request.material && product.materials) reasons.push(`Material matches ${request.material}`);
	return reasons;
}

export function compareCatalogProducts(
	left: CatalogProduct,
	right: CatalogProduct,
	request: NormalizedCatalogSearch,
): number {
	const query = rankQuery(right, request) - rankQuery(left, request);
	if (query) return query;
	const room = rankRoom(right, request) - rankRoom(left, request);
	if (room) return room;
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

function dimensionMatches(
	value: number | null,
	min: number | undefined,
	max: number | undefined,
	exclusiveMax = false,
): boolean {
	if (min === undefined && max === undefined) return true;
	if (value === null) return false;
	if (min !== undefined && value < min) return false;
	if (max !== undefined && (exclusiveMax ? value >= max : value > max)) return false;
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

/** Bound waiting even when a dependency fails to honor cancellation. */
export async function catalogDeadline<T>(
	run: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = AbortSignal.timeout(timeoutMs);
	const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () =>
			reject(
				new CatalogError(
					signal?.aborted ? "cancelled" : "timeout",
					signal?.aborted ? "Catalog request was cancelled" : "Catalog request timed out",
				),
			);
		active.addEventListener("abort", onAbort, { once: true });
		if (active.aborted) onAbort();
	});
	try {
		if (active.aborted) return await aborted;
		return await Promise.race([run(active), aborted]);
	} finally {
		if (onAbort) active.removeEventListener("abort", onAbort);
	}
}
