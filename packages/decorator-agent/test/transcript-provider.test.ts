import { replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createTranscriptService } from "../src/services/transcript-provider.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const repo = new MemorySessionRepo();
	cleanup.push(() => repo.close(context));
	const session = await repo.create({}, context);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, context);
	cleanup.push(() => harness.close(context));
	const lane = await harness.lane("main", context);
	return { repo, session, faux, models, harness, lane };
}

it("preserves recommendation details through repeated compaction and session reload", async () => {
	const { repo, session, faux, models, harness, lane } = await fixture();
	await lane.appendMessage({ role: "user", content: "Find lamps", timestamp: 1 }, context);
	const details = { searchId: "saved-search", products: [{ id: "lamp-1", name: "Reading lamp" }] };
	const cardId = await lane.appendMessage(
		{
			role: "toolResult",
			toolCallId: "catalog-call",
			toolName: "search_catalog",
			content: [{ type: "text", text: "One lamp found" }],
			details,
			isError: false,
			timestamp: 2,
		},
		context,
	);
	const transcript = createTranscriptService(lane, replicatedState);
	cleanup.push(() => transcript.dispose());
	await transcript.activate();
	for (let index = 0; index < 2; index++) {
		faux.setResponses([fauxAssistantMessage("The user is choosing a lamp.")]);
		expect(await lane.compact(undefined, context)).toMatchObject({
			ok: true,
			value: { compaction: { status: "completed" } },
		});
		const tip = await lane.getTipId(context);
		await expect.poll(() => transcript.service.state.value?.snapshot?.tipId).toBe(tip);
		expect(transcript.service.state.value?.snapshot?.transcript).toContainEqual(
			expect.objectContaining({ id: cardId, message: expect.objectContaining({ details }) }),
		);
		await lane.appendMessage({ role: "user", content: "Keep looking", timestamp: index + 3 }, context);
	}
	await transcript.dispose();
	await harness.close(context);
	const { harness: reopened } = await AgentHarness.create(
		{ session: await repo.open(session.metadata, context), models, model: faux.getModel() },
		context,
	);
	cleanup.push(() => reopened.close(context));
	const reopenedLane = await reopened.lane("main", context);
	const restored = createTranscriptService(reopenedLane, replicatedState);
	cleanup.push(() => restored.dispose());
	await restored.activate();
	expect(restored.service.state.value?.snapshot?.transcript).toEqual(
		await reopenedLane.findEntries({ order: "oldestFirst" }, context),
	);
	expect(restored.service.state.value?.snapshot?.transcript).toContainEqual(
		expect.objectContaining({ id: cardId, message: expect.objectContaining({ details }) }),
	);
});

it("applies events arriving during navigation rebasing to the refreshed transcript", async () => {
	const { lane } = await fixture();
	const targetId = await lane.appendMessage({ role: "user", content: "Original", timestamp: 1 }, context);
	const abandonedId = await lane.appendMessage({ role: "user", content: "Abandoned", timestamp: 2 }, context);
	const captured = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const watch = await lane.watch(context);
	const resnapshot = watch.resnapshot.bind(watch);
	vi.spyOn(watch, "resnapshot").mockImplementation(async (currentContext) => {
		const next = await resnapshot(currentContext);
		captured.resolve();
		await release.promise;
		return next;
	});
	vi.spyOn(lane, "watch").mockResolvedValue(watch);
	const transcript = createTranscriptService(lane, replicatedState);
	cleanup.push(() => transcript.dispose());
	await transcript.activate();
	try {
		expect(await lane.navigateTree(targetId, { summarize: false }, context)).toMatchObject({ ok: true });
		await captured.promise;
		const newId = await lane.appendMessage({ role: "user", content: "New branch", timestamp: 3 }, context);
		expect(transcript.service.state.value?.snapshot?.tipId).toBe(abandonedId);
		release.resolve();
		await expect.poll(() => transcript.service.state.value?.snapshot?.tipId).toBe(newId);
		expect(transcript.service.state.value?.snapshot?.transcript.map(({ id }) => id)).toEqual([targetId, newId]);
	} finally {
		release.resolve();
	}
});
