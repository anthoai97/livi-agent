import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type Branch,
	branchTip,
	insertEntry,
	MemorySessionRepo,
	setValue,
} from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it } from "vitest";
import { type CatalogProduct, type CatalogRecommendationDetails, mergeCatalogFollowUp } from "../src/catalog.ts";
import { loadRecommendationHistory } from "../src/catalog-history.ts";

const repos: MemorySessionRepo[] = [];
afterEach(async () => {
	for (const repo of repos.splice(0)) await repo.close(context);
});

const desk: CatalogProduct = {
	catalogId: "desk:original",
	name: "Original desk",
	imageUrl: null,
	productUrl: null,
	imageRef: null,
	dimensions: { width: 1.2, depth: 0.6, height: 0.75, unit: "m" },
	price: { amountMinor: 40000, currency: "USD" },
	category: "desk",
	style: null,
	color: null,
	materials: null,
	shape: null,
	availableColors: null,
	description: null,
	reasons: [],
};

function recommendations(searchId: string): CatalogRecommendationDetails {
	return {
		kind: "catalog_recommendations",
		searchId,
		products: [desk],
		resolvedConstraints: { category: ["desk"], excludeIds: ["blocked-product"] },
		pagination: { limit: 1, offset: 0, exhausted: false },
		shownIds: [desk.catalogId],
		binding: { designId: "original-room" },
		followUp: null,
	};
}

async function appendSearch(branch: Branch, details: CatalogRecommendationDetails, isError = false) {
	await branch.appendMessage(
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "search_catalog",
			content: [{ type: "text", text: "Bounded model representation" }],
			details,
			isError,
			timestamp: 0,
		},
		context,
	);
}

it("preserves catalog series, exclusions and earlier comparison references across compaction and reopen", async () => {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({}, context);
	const branch = await session.createBranch("main", null, context);
	const first = recommendations("search:original");
	await appendSearch(branch, first);
	const more: CatalogRecommendationDetails = {
		...first,
		products: [{ ...desk, catalogId: "desk:next", price: null, dimensions: null }],
		shownIds: [desk.catalogId, "desk:next"],
		followUp: "show_more",
	};
	for (let round = 0; round < 2; round++) {
		for (let index = 0; index < 205; index++)
			await branch.appendMessage({ role: "user", content: "Unrelated conversation", timestamp: index }, context);
		const parentId = await branch.getTipId(context);
		await session.mutate(async (mutator) => {
			await mutator.commit(
				[
					insertEntry({
						id: `compaction-${round}`,
						parentId,
						type: "compaction",
						summary: "Discussed furniture. Exact catalog references omitted.",
						retainedTail: [],
						tokensBefore: 40000,
						fromHook: false,
					}),
					setValue(branchTip("main"), `compaction-${round}`),
				],
				context,
			);
		}, context);
		if (round === 0) await appendSearch(branch, more);
	}
	await session.close(context);
	const recovered = await repo.open(session.metadata, context);
	const history = await loadRecommendationHistory(recovered, context);
	expect(history).toEqual([more, first]);
	const continuation = mergeCatalogFollowUp(history[0]!, "show_more");
	expect(continuation.request.omitIds).toEqual([desk.catalogId, "desk:next"]);
	expect(continuation.request.excludeIds).toEqual(["blocked-product"]);
	expect(continuation.searchId).toBe("search:original");
	const options = { referenceCatalogId: desk.catalogId, candidates: history.flatMap((entry) => entry.products) };
	expect(mergeCatalogFollowUp(history[0]!, "cheaper", options).request.maxPrice).toEqual({
		amountMinor: 39999,
		currency: "USD",
	});
	expect(mergeCatalogFollowUp(history[0]!, "smaller", { ...options, dimension: "width" }).request.maxWidth).toBe(1.2);
});

it("resolves an older explicit search independently of the latest search and ignores failed results", async () => {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({}, context);
	const branch = await session.createBranch("main", null, context);
	const first = recommendations("first");
	await appendSearch(branch, first);
	for (let index = 0; index < 205; index++)
		await branch.appendMessage({ role: "user", content: "Unrelated conversation", timestamp: index }, context);
	const latest = recommendations("latest");
	await appendSearch(branch, latest);
	await appendSearch(branch, recommendations("failed"), true);
	expect(await loadRecommendationHistory(session, context, "first")).toEqual([first]);
	expect(await loadRecommendationHistory(session, context)).toEqual([latest]);
	expect(await loadRecommendationHistory(session, context, "missing")).toEqual([]);
	const unrelated = await repo.create({}, context);
	expect(await loadRecommendationHistory(unrelated, context)).toEqual([]);
});
