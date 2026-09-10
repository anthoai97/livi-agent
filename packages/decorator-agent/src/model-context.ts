import type { CatalogDetailResult, CatalogProduct, CatalogRecommendationDetails } from "./catalog.ts";
import type { StudioPlanningSnapshot } from "./studio-journal.ts";

export const CATALOG_CONTEXT_BYTES = 12_000;
export const ROOM_CONTEXT_BYTES = 16_000;
export const REFERENCE_CONTEXT_BYTES = 4_000;

function text(value: string | null | undefined, limit = 256) {
	return value && value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
}

/** Fit whole records, never partial JSON or shortened identifiers. Metadata counts omitted records. */
export function modelRecords(
	metadata: Record<string, unknown>,
	key: string,
	records: readonly unknown[],
	maxBytes: number,
): string {
	const included: unknown[] = [];
	const result: Record<string, unknown> & { omitted: number } = {
		...metadata,
		[key]: included,
		omitted: records.length,
		...(typeof metadata.offset === "number" ? { nextOffset: records.length ? metadata.offset + 1 : null } : {}),
	};
	let encoded = JSON.stringify(result);
	if (Buffer.byteLength(encoded) > maxBytes)
		return JSON.stringify({
			unavailable: "Context metadata exceeds the display budget; do not guess missing references.",
		});
	for (const record of records) {
		included.push(record);
		result.omitted--;
		if (typeof metadata.offset === "number")
			result.nextOffset = result.omitted ? metadata.offset + included.length : null;
		const candidate = JSON.stringify(result);
		if (Buffer.byteLength(candidate) > maxBytes) {
			included.pop();
			result.omitted++;
			break;
		}
		encoded = candidate;
	}
	return encoded;
}

function productContext(product: CatalogProduct, detailed: boolean) {
	return {
		catalogId: product.catalogId,
		name: text(product.name),
		price: product.price,
		dimensions: product.dimensions,
		category: text(product.category),
		style: text(product.style),
		color: text(product.color),
		materials: text(product.materials),
		shape: text(product.shape),
		availableColors: product.availableColors?.slice(0, 8).map((color) => text(color)),
		omittedColors: Math.max(0, (product.availableColors?.length ?? 0) - 8),
		...(detailed ? { description: text(product.description, 1024) } : {}),
	};
}

export function catalogModelContext(
	payload: CatalogRecommendationDetails | CatalogDetailResult,
	maxBytes = CATALOG_CONTEXT_BYTES,
): string {
	if ("product" in payload)
		return modelRecords({ kind: "product_details" }, "products", [productContext(payload.product, true)], maxBytes);
	const { originalQuery, query, category, color, style, material, excludeIds, target, ...constraints } =
		payload.resolvedConstraints;
	const metadata: Record<string, unknown> = {
		kind: payload.kind,
		searchId: payload.searchId,
		resolvedConstraints: {
			...constraints,
			originalQuery: text(originalQuery, 512),
			query: text(query, 512),
			category: category?.slice(0, 8).map((entry) => text(entry)),
			color: text(color),
			style: text(style),
			material: text(material),
			target: target ? { ...target, category: text(target.category) } : undefined,
			excludedCount: excludeIds?.length ?? 0,
		},
		pagination: payload.pagination,
		retrieval: payload.retrieval,
		binding: payload.binding,
		followUp: payload.followUp,
		shownCount: payload.shownIds.length,
		note: "Full cards and exclusions are saved. Use followUp to preserve filters; get_product_details retrieves one exact catalogId. Retailer color options do not verify the asset variant.",
	};
	if (Buffer.byteLength(JSON.stringify(metadata)) > maxBytes / 2) {
		metadata.resolvedConstraints = {
			...constraints,
			target: target ? { ...target, category: text(target.category) } : undefined,
		};
		metadata.constraintsTextOmitted = true;
	}
	return modelRecords(
		metadata,
		"products",
		payload.products.map((product) => productContext(product, false)),
		maxBytes,
	);
}

export interface RoomContextQuery {
	objectId?: string;
	query?: string;
	offset?: number;
}

export function roomModelContext(planning: StudioPlanningSnapshot | undefined, query: RoomContextQuery = {}): string {
	if (!planning) return JSON.stringify({ unavailable: "No room planning evidence; room actions unavailable" });
	const { snapshot, originalQuery, unavailable, ...identity } = planning;
	if (!snapshot)
		return modelRecords(
			{ ...identity, unavailable: text(unavailable), snapshot: null },
			"objects",
			[],
			ROOM_CONTEXT_BYTES,
		);
	const selected = new Set(snapshot.selectedObjectIds);
	const requested = (query.query ?? originalQuery ?? "").toLocaleLowerCase();
	const targetId = planning.action?.type === "replace_asset" ? planning.action.targetObjectId : undefined;
	const ranked = snapshot.objects
		.filter((object) =>
			query.objectId
				? object.id === query.objectId
				: query.query
					? [object.name, object.category].some((label) => label.toLocaleLowerCase().includes(requested))
					: true,
		)
		.map((object) => {
			let rank = 0;
			if (object.id === targetId) rank = 3;
			else if (
				[object.name, object.category].some((label) => label && requested.includes(label.toLocaleLowerCase()))
			)
				rank = 2;
			else if (selected.has(object.id)) rank = 1;
			return { object, rank };
		})
		.sort((a, b) => b.rank - a.rank);
	const offset = query.offset ?? 0;
	const objects = ranked.slice(offset).map(({ object }) => ({
		...object,
		name: text(object.name),
		category: text(object.category),
		selected: selected.has(object.id),
	}));
	const geometryFits = Buffer.byteLength(JSON.stringify(snapshot.geometry)) <= 2_000;
	const openingsFit = Buffer.byteLength(JSON.stringify(snapshot.openings)) <= 2_000;
	return modelRecords(
		{
			...identity,
			unavailable: text(unavailable),
			originalQuery: text(originalQuery, 512),
			designId: snapshot.designId,
			revision: snapshot.revision,
			geometry: geometryFits ? snapshot.geometry : undefined,
			geometryOmitted: !geometryFits,
			openings: openingsFit ? snapshot.openings : undefined,
			openingsOmitted: !openingsFit,
			budget: snapshot.budget,
			selectedCount: selected.size,
			totalObjects: snapshot.objects.length,
			matchingObjects: ranked.length,
			offset,
			note: "Inventory may be partial. Use get_room_context with objectId, query (name/category), or nextOffset as offset to read more. If no objects fit, nextOffset skips one oversized record. Never infer an object is absent from a partial inventory.",
		},
		"objects",
		objects,
		ROOM_CONTEXT_BYTES,
	);
}
