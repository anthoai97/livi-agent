import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startLiviServer } from "../livi-server/src/server.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../packages/ai/dist/index.js";
import { JsonStudioAdapter } from "./studio-smoke/adapter.js";
import { eventually } from "./studio-smoke/connection.js";
import { readRoom } from "./studio-smoke/room.js";

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
let server = await startLiviServer({ dataDirectory: directory, port: 0, models });
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
	server = await startLiviServer({ dataDirectory: directory, port, models });
	assert.equal(server.serverId, identity);
	await page.getByText("Recovered answer after server restart.", { exact: true }).waitFor();
	assert.equal(await page.getByText("Recover this browser question.", { exact: true }).count(), 1);
	assert.equal(await page.getByRole("navigation", { name: "Conversations" }).getByRole("button").count(), 2);
	const fixture = await readRoom("scripts/studio-smoke/fixtures/synthetic-room.json");
	adapter = new JsonStudioAdapter(join(directory, "studio.json"), "browser-studio");
	await adapter.load(fixture.snapshot);
	await adapter.connect(server);
	await adapter.select(["chair-red-1"]);
	await page
		.getByLabel("Connected Studios", { exact: true })
		.selectOption(JSON.stringify(["synthetic-room", "browser-studio"]));
	await page.getByRole("button", { name: "Attach design", exact: true }).click();
	await page.getByText("Selected: Red chair (chair-red-1)", { exact: true }).waitFor();
	await page.getByText("Design synthetic-room", { exact: true }).waitFor();
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("move_object", { objectId: "chair-red-1", position: [1.5, 1, 0] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The selected Red chair moved half a metre right."),
	]);
	await page
		.getByRole("textbox", { name: "Message", exact: true })
		.fill("Move the selected chair half a metre right.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByText("The selected Red chair moved half a metre right.", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	assert.deepEqual(adapter.snapshot.objects[0]!.position, [1.5, 1, 0]);
	const actions = page.getByRole("region", { name: "Room actions", exact: true });
	await actions.locator(".studio-action.committed > span").waitFor();
	assert.equal(await page.locator(".message.toolResult").count(), 0, "Raw tool results must not enter chat");
	assert.equal(await page.locator(".message").filter({ hasText: '"commandId"' }).count(), 0);
	await page.reload();
	await page.getByText("Design synthetic-room", { exact: true }).waitFor();
	await actions.locator(".studio-action.committed > span").waitFor();
	assert.equal(adapter.emitted.length, 1, "Hydration must not resubmit a command");

	// A saved command with a dropped reply remains visible after Stop, then hydrates its late outcome.
	adapter.dropNextReply = true;
	faux.appendResponses([
		fauxAssistantMessage(fauxToolCall("rotate_object", { objectId: "chair-red-1", rotation: [0, 0, Math.PI / 2] }), {
			stopReason: "toolUse",
		}),
	]);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Rotate the selected chair 90 degrees.");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await eventually(() => adapter!.saveCount === 2, "browser action saved before dropped reply");
	await actions.getByText("Waiting for saved outcome", { exact: true }).waitFor();
	assert.equal(await page.getByLabel("Connected Studios", { exact: true }).isDisabled(), true);
	assert.equal(await page.getByRole("button", { name: "Disconnect design", exact: true }).isDisabled(), true);
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden" });
	await adapter.disconnect();
	await page.getByRole("region", { name: "Studio attachment" }).getByText("Offline", { exact: true }).waitFor();
	adapter = new JsonStudioAdapter(join(directory, "studio.json"), "browser-studio");
	await adapter.load(fixture.snapshot);
	await adapter.connect(server);
	await actions.getByText("Waiting for saved outcome", { exact: true }).waitFor({ state: "hidden" });
	assert.equal(await actions.locator(".studio-action.committed > span").count(), 2);
	assert.equal(adapter.emitted.length, 0, "Reconciliation must use durable status, not another edit");
	assert.equal(adapter.saveCount, 2);
	await page.reload();
	await actions.locator(".studio-action.committed > span").first().waitFor();
	assert.equal(await actions.locator(".studio-action.committed > span").count(), 2);
	await page.getByRole("button", { name: "Disconnect design", exact: true }).click();
	await page.getByText("No design attached", { exact: true }).waitFor();
	await mkdir("artifacts", { recursive: true });
	await page.screenshot({ path: "artifacts/chat-browser.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "artifacts/chat-browser-mobile.png", fullPage: true });
	assert.deepEqual(errors, []);
	console.log(
		"Browser verification passed: two chats, streaming, Stop, restart recovery, Studio attachment, selection, action results, unresolved lock, and late saved outcome after reconnect. Synthetic JSON saves only.",
	);
} finally {
	await browser.close();
	await adapter?.disconnect();
	await server.close();
	await rm(directory, { recursive: true, force: true });
}
