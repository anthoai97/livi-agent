import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startLiviServer } from "../livi-server/src/server.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../packages/ai/dist/index.js";
import { type CatalogProduct, createMemoryCatalogAccess } from "../packages/decorator-agent/src/catalog.ts";
import { JsonStudioAdapter } from "./studio-smoke/adapter.js";
import { eventually } from "./studio-smoke/connection.js";
import { readRoom } from "./studio-smoke/room.js";

function catalogProduct(catalogId: string, fields: Partial<CatalogProduct> & { name: string }): CatalogProduct {
	return {
		catalogId,
		imageUrl: null,
		productUrl: null,
		imageRef: null,
		dimensions: null,
		price: null,
		category: null,
		style: null,
		color: null,
		materials: null,
		shape: null,
		availableColors: null,
		description: null,
		reasons: [],
		...fields,
	};
}

const catalog = createMemoryCatalogAccess([
	catalogProduct("yellow-haven", {
		name: "Haven Yellow Sectional Sofa",
		category: "sectional_sofa",
		color: "yellow",
		imageUrl: "https://cdn.example/haven.jpg",
		productUrl: "https://shop.example/haven",
		price: { amountMinor: 49999, currency: "USD" },
		dimensions: { width: 2.8, depth: 1.6, height: 0.9, unit: "m" },
		description: "A yellow sectional sofa",
	}),
	catalogProduct("yellow-cove", {
		name: "Cove Yellow Sectional",
		category: "sectional",
		color: "yellow",
	}),
	catalogProduct("yellow-bend", {
		name: "Bend Yellow L-Shaped Sectional",
		category: "sectional_sofa",
		color: "yellow",
		shape: "L-shaped",
	}),
]);

const directory = await mkdtemp(join(tmpdir(), "livi-browser-"));
const faux = fauxProvider({
	provider: "google",
	models: [{ id: "gemini-3.5-flash-lite" }],
	tokensPerSecond: 20,
	tokenSize: { min: 1, max: 1 },
});
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage("Warm lighting and a soft rug make a cozy room."),
	fauxAssistantMessage("A blue accent wall suits the second room."),
	fauxAssistantMessage("This long response can be stopped. ".repeat(40)),
	fauxAssistantMessage("An interrupted answer that will be regenerated. ".repeat(40)),
	fauxAssistantMessage("Recovered answer after server restart."),
]);
let server = await startLiviServer({ dataDirectory: directory, port: 0, models, catalog });
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
let adapter: JsonStudioAdapter | undefined;
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15_000);
try {
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.getByRole("button", { name: "Studio", exact: true }).waitFor();
	assert.equal(await page.locator("#studio-panel").isVisible(), false);
	assert.equal(await page.getByRole("button", { name: "Studio", exact: true }).getAttribute("aria-expanded"), "false");
	assert.equal(await page.locator("#chats-panel").isVisible(), false);
	assert.equal(await page.getByRole("button", { name: "Chats", exact: true }).getAttribute("aria-expanded"), "false");
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	assert.equal(
		await page.getByRole("button", { name: "Hide chats", exact: true }).getAttribute("aria-expanded"),
		"true",
	);
	await page.getByRole("button", { name: "Hide chats", exact: true }).click();
	assert.equal(await page.locator("#chats-panel").isVisible(), false);
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await page.getByRole("button", { name: "+ New chat", exact: true }).click();
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("How can I make room one cozy?");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("Warm lighting and a soft rug make a cozy room.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "+ New chat", exact: true }).click();
	await page.getByText("Warm lighting and a soft rug make a cozy room.", { exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Suggest a color for room two.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("A blue accent wall suits the second room.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	assert.equal(await page.getByText("Warm lighting and a soft rug make a cozy room.", { exact: true }).count(), 0);
	await page.getByRole("navigation", { name: "Conversations" }).getByRole("button").nth(1).click();
	await page.getByText("Warm lighting and a soft rug make a cozy room.", { exact: true }).waitFor();
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Give me a long answer.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	await page.reload();
	await page.getByText("Warm lighting and a soft rug make a cozy room.", { exact: true }).waitFor();
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Recover this browser question.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
	// Wait for actual provider streaming before interrupting the runtime.
	await page.locator(".message.assistant").filter({ hasText: "An interrupted" }).waitFor();
	const port = server.port;
	const identity = server.serverId;
	await server.close();
	server = await startLiviServer({ dataDirectory: directory, port, models, catalog });
	assert.equal(server.serverId, identity);
	await page.getByText("Recovered answer after server restart.", { exact: true }).waitFor();
	assert.equal(await page.getByText("Recover this browser question.", { exact: true }).count(), 1);
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	assert.equal(await page.getByRole("navigation", { name: "Conversations" }).getByRole("button").count(), 2);
	const fixture = await readRoom("scripts/studio-smoke/fixtures/synthetic-room.json");
	adapter = new JsonStudioAdapter(join(directory, "studio.json"), "browser-studio");
	await adapter.load(fixture.snapshot);
	await adapter.connect(server);
	await adapter.select([]);
	await page.getByRole("button", { name: "Studio", exact: true }).click();
	assert.equal(
		await page.getByRole("button", { name: "Hide Studio", exact: true }).getAttribute("aria-expanded"),
		"true",
	);
	await page
		.getByLabel("Connected Studios", { exact: true })
		.selectOption(JSON.stringify(["synthetic-room", "browser-studio"]));
	await page.getByRole("button", { name: "Attach design", exact: true }).click();
	await page.getByText("Name an object in your message", { exact: false }).waitFor();
	await page.getByText("Design synthetic-room", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Hide Studio", exact: true }).click();
	assert.equal(await page.locator("#studio-panel").isVisible(), false);
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-red-1", position: [1.5, 1, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The Red chair moved half a metre right."),
	]);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Move the Red chair half a metre right.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("The Red chair moved half a metre right.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	assert.deepEqual(adapter.snapshot.objects[0]!.position, [1.5, 1, 0]);
	assert.equal(await page.locator(".message.toolResult").count(), 0, "Raw tool results must not enter chat");
	assert.equal(await page.locator(".message").filter({ hasText: '"commandId"' }).count(), 0);
	await page.reload();
	await page.getByRole("button", { name: "Studio", exact: true }).click();
	await page.getByText("Design synthetic-room", { exact: true }).waitFor();
	assert.equal(adapter.emitted.length, 1, "Hydration must not resubmit a command");

	// A dropped reply ends without recovery work and permits the next explicit request.
	adapter.dropNextReply = true;
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-red-1", rotation: [0, 0, Math.PI / 2] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Studio disconnected before a result arrived. Check the room before another edit."),
	]);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Rotate the Red chair 90 degrees.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await eventually(() => adapter!.saveCount === 2, "browser action saved before dropped reply");
	await adapter.disconnect();
	await page
		.getByText("Studio disconnected before a result arrived. Check the room before another edit.", { exact: true })
		.waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	assert.equal(await page.getByRole("button", { name: "Disconnect design", exact: true }).isDisabled(), false);
	adapter = new JsonStudioAdapter(join(directory, "studio.json"), "browser-studio");
	await adapter.load(fixture.snapshot);
	await adapter.connect(server);
	await page.getByRole("region", { name: "Studio attachment" }).getByText("Ready", { exact: true }).waitFor();
	assert.equal(adapter.emitted.length, 0, "Reconnect must not resend an edit");
	assert.equal(
		adapter.requests.every((type) => type === "context"),
		true,
		"Reconnect sends no status lookup or edit",
	);
	const currentRevision = adapter.snapshot.revision;
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-red-1", position: [2, 1, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Moved the Red chair to two metres."),
	]);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Move the Red chair to [2,1,0].");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("Moved the Red chair to two metres.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	assert.equal(adapter.emitted.length, 1);
	assert.equal(
		adapter.emitted[0]!.expectedRevision,
		currentRevision,
		"Next request uses Studio current state after the lost reply",
	);
	assert.equal(adapter.saveCount, 3);
	assert.deepEqual(adapter.snapshot.objects[0]!.position, [2, 1, 0]);
	await page.getByRole("button", { name: "Disconnect design", exact: true }).click();
	await page.getByText("No design attached", { exact: true }).waitFor();
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("search_catalog", { color: "yellow", category: "sectional" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Here are yellow sectional sofas to consider for your room."),
	]);
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await page.getByRole("button", { name: "+ New chat", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Message", exact: true })
		.fill("Can you replace the current sofa with a yello sectional sofa");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("Here are yellow sectional sofas to consider for your room.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	const cards = page.locator("[data-catalog-id]");
	assert.equal(await cards.count(), 3);
	assert.equal(await page.locator("[data-catalog-id='yellow-bend']").count(), 1);
	assert.equal(await page.getByRole("heading", { name: "Haven Yellow Sectional Sofa", exact: true }).count(), 1);
	assert.equal(await page.getByRole("heading", { name: "Cove Yellow Sectional", exact: true }).count(), 1);
	assert.match(await page.locator("[data-catalog-id='yellow-haven'] .catalog-card-price").innerText(), /499\.99/);
	assert.equal(await page.getByText("Price unavailable", { exact: true }).count(), 2);
	assert.equal(await page.getByRole("link", { name: "View product", exact: true }).count(), 1);
	assert.equal(await page.getByRole("button", { name: /add|replace|change sofa/i }).count(), 0);
	assert.equal(await page.locator(".message.toolResult").count(), 0, "Raw tool results must not enter chat");
	assert.equal(await page.locator(".message").filter({ hasText: '"searchId"' }).count(), 0);
	const catalogIds = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-catalog-id")));
	await page.reload();
	await page.getByText("Here are yellow sectional sofas to consider for your room.", { exact: true }).waitFor();
	assert.deepEqual(
		await page
			.locator("[data-catalog-id]")
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-catalog-id"))),
		catalogIds,
	);
	assert.match(await page.locator("[data-catalog-id='yellow-haven'] .catalog-card-price").innerText(), /499\.99/);
	await mkdir("artifacts", { recursive: true });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.locator("[data-catalog-id='yellow-bend']").scrollIntoViewIfNeeded();
	await page.screenshot({ path: "artifacts/chat-browser.png" });
	await page.locator(".message.assistant").last().screenshot({ path: "artifacts/chat-cards-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator("[data-catalog-id='yellow-bend']").scrollIntoViewIfNeeded();
	await page.screenshot({ path: "artifacts/chat-browser-mobile.png" });
	await page.locator(".message.assistant").last().screenshot({ path: "artifacts/chat-cards-mobile.png" });
	assert.deepEqual(errors, []);
	console.log(
		"Browser verification passed: chat sidebar toggle, two chats, streaming, Stop, restart recovery, Studio panel toggle and attachment, named object without selection, saved response, lost reply, next explicit edit after reconnect, and catalog cards from saved details. Synthetic JSON saves only.",
	);
} finally {
	await browser.close();
	await adapter?.disconnect();
	await server.close();
	await rm(directory, { recursive: true, force: true });
}
