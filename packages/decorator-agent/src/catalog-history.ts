import type { Context } from "@earendil-works/chord";
import type { EntryCursor, Session } from "@earendil-works/pi-agent-core/harness/session";
import { type CatalogRecommendationDetails, isCatalogRecommendationDetails } from "./catalog.ts";

/** Persisted tool details remain authoritative even after model context is compacted. */
export async function loadRecommendationHistory(
	session: Session,
	context: Context,
	searchId?: string,
): Promise<CatalogRecommendationDetails[]> {
	const matches: CatalogRecommendationDetails[] = [];
	let cursor: EntryCursor | undefined;
	for (;;) {
		const entries = await session.findEntries({ type: "message", order: "desc", limit: 200, cursor }, context);
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
			if (entry.message.toolName !== "search_catalog") continue;
			if (!isCatalogRecommendationDetails(entry.message.details)) continue;
			searchId ??= entry.message.details.searchId;
			if (entry.message.details.searchId === searchId) matches.push(entry.message.details);
		}
		if (entries.length < 200) return matches;
		cursor = { seq: entries[entries.length - 1]!.seq };
	}
}
