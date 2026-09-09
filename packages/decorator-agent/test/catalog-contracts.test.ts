import { expect, it } from "vitest";
import {
	catalogDeadline,
	catalogResolvedConstraints,
	normalizeCatalogSearchRequest,
	requestFromConstraints,
} from "../src/catalog.ts";

it("round trips original intent and grounded evidence without creating financial constraints", () => {
	const originalQuery = "Can you replace the current sofa with a yello sectional sofa";
	const target = { designId: "room", revision: "7", objectId: "sofa-1", catalogId: "old-sofa", category: "sofa" };
	const resolved = catalogResolvedConstraints(
		normalizeCatalogSearchRequest({
			originalQuery,
			query: "yellow sectional",
			purpose: "replacement",
			target,
			excludeIds: ["old-sofa"],
		}),
	);
	const restored = requestFromConstraints(JSON.parse(JSON.stringify(resolved)));
	expect(restored).toMatchObject({
		originalQuery,
		query: "yellow sectional",
		purpose: "replacement",
		target,
		excludeIds: ["old-sofa"],
	});
	expect(restored.minPrice).toBeUndefined();
	expect(restored.maxPrice).toBeUndefined();
});

it("cancels waiting for an uncooperative backend and distinguishes a deadline", async () => {
	const controller = new AbortController();
	const cancelled = catalogDeadline(() => new Promise(() => {}), controller.signal);
	controller.abort();
	await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
	await expect(catalogDeadline(() => new Promise(() => {}), undefined, 5)).rejects.toMatchObject({ code: "timeout" });
});
