import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRemoteServiceBinding } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { value } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type ByteTransportFactory, Client, createClientServiceTransport } from "@earendil-works/pi-client";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	AgentController,
	SessionDirectory,
	SessionManagement,
	type StudioCommand,
	type StudioCommandResult,
	StudioConnection,
	StudioDirectory,
	Transcript,
} from "@livi/decorator-agent/contracts";
import { WebSocket } from "ws";
import { startLiviServer } from "../src/server.ts";

function transport(port: number): ByteTransportFactory {
	return (handlers) =>
		new Promise((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
			socket.on("open", () =>
				resolve({
					send: (bytes) =>
						new Promise<void>((done, fail) =>
							socket.send(bytes, { binary: true }, (error) => (error ? fail(error) : done())),
						),
					close: () => socket.close(),
				}),
			);
			socket.on("message", (data) =>
				handlers.onData(
					Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data,
				),
			);
			socket.on("close", handlers.onClose);
			socket.on("error", (error) => {
				reject(error);
				handlers.onError(error);
			});
		});
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for replicated state");
		await new Promise((done) => setTimeout(done, 10));
	}
}

async function connect(server: { serverId: string; port: number }) {
	const client = await Client.connect({ serverId: server.serverId, transportFactory: transport(server.port) });
	const binding = createRemoteServiceBinding({
		services: [SessionManagement, SessionDirectory],
		transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
	});
	const management = binding.use(SessionManagement);
	const directory = binding.use(SessionDirectory);
	await binding.ready(context);
	return { client, management, directory, binding };
}

async function attach(connection: Awaited<ReturnType<typeof connect>>, sessionId: string) {
	await connection.management.attach(sessionId, context);
	const binding = createRemoteServiceBinding({
		services: [AgentController, Transcript],
		transport: createClientServiceTransport(connection.client, () => connection.client.attachment),
	});
	const controller = binding.use(AgentController);
	const transcript = binding.use(Transcript);
	await binding.ready(context);
	return { controller, transcript, binding };
}

function messages(transcript: Transcript): string[] {
	return (transcript.state.value?.snapshot?.transcript ?? []).flatMap((entry) => {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
		return typeof entry.message.content === "string"
			? [entry.message.content]
			: entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
	});
}

test(
	"real WebSocket routes isolate conversations, stream, reconnect, and survive SQLite restart",
	{ timeout: 30_000 },
	async (t) => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "livi-server-"));
		const faux = fauxProvider({
			provider: "google",
			models: [{ id: "gemini-3.8-flash" }],
			tokensPerSecond: 100,
			tokenSize: { min: 1, max: 1 },
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("A quiet room with warm lighting.");
			},
		]);
		const errors: Error[] = [];
		let server = await startLiviServer({ dataDirectory, port: 0, models, onError: (error) => errors.push(error) });
		const connections: Awaited<ReturnType<typeof connect>>[] = [];
		t.after(async () => {
			release.resolve();
			await Promise.all(connections.map(({ client }) => client.dispose()));
			await server.close();
			await rm(dataDirectory, { recursive: true, force: true });
		});
		const first = await connect(server);
		const second = await connect(server);
		connections.push(first, second);
		const roomA = await first.management.create({}, context);
		const roomB = await second.management.create({}, context);
		assert.notEqual(roomA.sessionId, roomB.sessionId);
		await eventually(() => second.directory.state.value?.sessions.length === 2);
		const a = await attach(first, roomA.sessionId);
		const b = await attach(second, roomB.sessionId);
		const malformed = await a.controller.prompt(
			{ message: "Add lamps", action: { type: "add_asset", selectedProductId: "lamp-1", quantity: 0 } },
			context,
		);
		assert.deepEqual(malformed, {
			accepted: false,
			operationId: null,
			error: { code: "invalid_message", message: "add_asset quantity must be a positive integer" },
		});
		assert.equal(faux.state.callCount, 0, "Malformed wire actions must not start generation");
		const response = await a.controller.prompt({ message: "Design a quiet room" }, context);
		assert.equal(response.accepted, true);
		await started.promise;
		const busy = await a.controller.prompt({ message: "Another request" }, context);
		assert.equal(busy.accepted, false);
		if (!busy.accepted) assert.equal(busy.error.code, "lane_busy");
		await eventually(() => messages(a.transcript).includes("Design a quiet room"));
		assert.deepEqual(messages(b.transcript), []);

		first.client.disconnect();
		await first.binding.rebind(false, context);
		await eventually(() => server.connectionCount === 1);
		const detached = await attach(second, roomA.sessionId);
		let detachedUpdates = 0;
		detached.transcript.state.subscribe(() => {
			detachedUpdates += 1;
		});
		await detached.binding.dispose(context);
		const updatesAtDispose = detachedUpdates;
		await second.management.detach(context);
		const observer = await attach(second, roomA.sessionId);
		let sawStreaming = false;
		const stop = observer.transcript.state.subscribe((state) => {
			if (
				state.snapshot?.operation?.streamingMessage?.content.some(
					(block) => block.type === "text" && block.text.length > 0,
				)
			)
				sawStreaming = true;
		});
		release.resolve();
		await eventually(
			() =>
				messages(observer.transcript).includes("A quiet room with warm lighting.") &&
				observer.transcript.state.value?.snapshot?.operation === null,
		);
		stop();
		assert.equal(sawStreaming, true);
		assert.equal(detachedUpdates, updatesAtDispose, "Disposed subscribers must receive no further stream updates");
		assert.equal(faux.state.callCount, 1, "Disconnect must not cancel or duplicate an accepted operation");

		await first.client.reconnect();
		await first.binding.rebind(true, context);
		const reconnected = await attach(first, roomA.sessionId);
		assert.deepEqual(messages(reconnected.transcript), ["Design a quiet room", "A quiet room with warm lighting."]);
		await reconnected.binding.dispose(context);
		await first.client.dispose();
		await second.client.dispose();
		await eventually(() => server.connectionCount === 0);
		const serverId = server.serverId;
		await server.close();
		server = await startLiviServer({ dataDirectory, port: 0, models, onError: (error) => errors.push(error) });
		assert.equal(server.serverId, serverId);
		const restored = await connect(server);
		connections.push(restored);
		assert.deepEqual(
			restored.directory.state.value?.sessions.map((session) => session.sessionId).sort(),
			[roomA.sessionId, roomB.sessionId].sort(),
		);
		const restoredA = await attach(restored, roomA.sessionId);
		assert.deepEqual(messages(restoredA.transcript), ["Design a quiet room", "A quiet room with warm lighting."]);
		assert.equal(faux.state.callCount, 1, "Reopening a completed session must not restart generation");
		faux.appendResponses([
			(request) => {
				assert.deepEqual(
					request.messages.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
					),
					["Design a quiet room", "A quiet room with warm lighting.", "Which lamp fits?"],
				);
				return fauxAssistantMessage("Choose a warm floor lamp.");
			},
		]);
		assert.equal((await restoredA.controller.prompt({ message: "Which lamp fits?" }, context)).accepted, true);
		await eventually(
			() =>
				messages(restoredA.transcript).includes("Choose a warm floor lamp.") &&
				restoredA.transcript.state.value?.snapshot?.operation === null,
		);
		const restoredB = await attach(restored, roomB.sessionId);
		assert.deepEqual(messages(restoredB.transcript), []);
		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid API key" })]);
		assert.equal((await restoredB.controller.prompt({ message: "Show a provider failure" }, context)).accepted, true);
		await eventually(() => restoredB.transcript.state.value?.snapshot?.lastResult?.status === "failed");
		assert.match(restoredB.transcript.state.value?.snapshot?.lastResult?.error?.message ?? "", /Invalid API key/);
		assert.equal(restoredB.transcript.state.value?.snapshot?.operation, null);
		faux.appendResponses([fauxAssistantMessage("The next request succeeds.")]);
		assert.equal((await restoredB.controller.prompt({ message: "Try again" }, context)).accepted, true);
		await eventually(
			() =>
				messages(restoredB.transcript).includes("The next request succeeds.") &&
				restoredB.transcript.state.value?.snapshot?.operation === null,
		);
		await assert.rejects(restored.management.attach("missing-session", context), /Unknown conversation/);
		assert.equal(faux.state.callCount, 4);
		assert.deepEqual(errors, []);
	},
);

test(
	"provider optional fields stream over WebSocket and preserve signatures after reconnect",
	{ timeout: 30_000 },
	async (t) => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "livi-provider-fields-"));
		const faux = fauxProvider({
			provider: "google",
			models: [{ id: "gemini-3.8-flash" }],
			tokensPerSecond: 100,
			tokenSize: { min: 1, max: 1 },
		});
		const models = createModels();
		models.setProvider(faux.provider);
		const content = [
			{ type: "thinking" as const, thinking: "Considering the room.", thinkingSignature: undefined },
			{ type: "thinking" as const, thinking: "Use warm lighting.", thinkingSignature: "dGhpbmtpbmc=" },
			{ type: "text" as const, text: "Choose a warm ", textSignature: undefined },
			{ type: "text" as const, text: "floor lamp.", textSignature: "dGV4dA==" },
		];
		const reply = fauxAssistantMessage(content);
		reply.responseId = undefined;
		faux.setResponses([
			reply,
			(request) => {
				const previous = request.messages.find((message) => message.role === "assistant");
				assert.ok(previous);
				assert.deepEqual(previous.content, JSON.parse(JSON.stringify(content)));
				return fauxAssistantMessage("A linen shade fits.");
			},
		]);
		const errors: Error[] = [];
		const server = await startLiviServer({ dataDirectory, port: 0, models, onError: (error) => errors.push(error) });
		const connection = await connect(server);
		t.after(async () => {
			await connection.client.dispose();
			await server.close();
			await rm(dataDirectory, { recursive: true, force: true });
		});
		const room = await connection.management.create({}, context);
		const attached = await attach(connection, room.sessionId);
		let sawStreaming = false;
		const unsubscribe = attached.transcript.state.subscribe((state) => {
			if (
				state.snapshot?.operation?.streamingMessage?.content.some(
					(block) => block.type === "text" && block.text.length > 0,
				)
			)
				sawStreaming = true;
		});
		assert.equal((await attached.controller.prompt({ message: "Suggest lighting" }, context)).accepted, true);
		await eventually(() => {
			assert.deepEqual(errors, [], "Provider fields must be valid on the protocol wire");
			return (
				messages(attached.transcript).includes("floor lamp.") &&
				attached.transcript.state.value?.snapshot?.operation === null
			);
		});
		unsubscribe();
		assert.equal(sawStreaming, true);
		await attached.binding.dispose(context);
		connection.client.disconnect();
		await connection.binding.rebind(false, context);
		await eventually(() => server.connectionCount === 0);
		await connection.client.reconnect();
		await connection.binding.rebind(true, context);
		const reconnected = await attach(connection, room.sessionId);
		assert.deepEqual(messages(reconnected.transcript), ["Suggest lighting", "Choose a warm ", "floor lamp."]);
		const entry = reconnected.transcript.state.value?.snapshot?.transcript.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		assert.ok(entry?.type === "message" && entry.message.role === "assistant");
		assert.deepEqual(entry.message.content, JSON.parse(JSON.stringify(content)));
		assert.equal((await reconnected.controller.prompt({ message: "Which shade?" }, context)).accepted, true);
		await eventually(
			() =>
				messages(reconnected.transcript).includes("A linen shade fits.") &&
				reconnected.transcript.state.value?.snapshot?.operation === null,
		);
		assert.deepEqual(errors, []);
	},
);

test(
	"a killed server resumes the durable accepted operation without duplicating the user message",
	{ timeout: 30_000 },
	async (t) => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "livi-recovery-"));
		const child = fork(new URL("./interrupted-server.ts", import.meta.url), [dataDirectory], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		let restarted: Awaited<ReturnType<typeof startLiviServer>> | undefined;
		const connections: Awaited<ReturnType<typeof connect>>[] = [];
		t.after(async () => {
			child.kill("SIGKILL");
			await Promise.all(connections.map(({ client }) => client.dispose()));
			await restarted?.close();
			await rm(dataDirectory, { recursive: true, force: true });
		});
		const [ready] = (await once(child, "message")) as [{ type: string; serverId: string; port: number }];
		assert.equal(ready.type, "ready");
		const first = await connect(ready);
		connections.push(first);
		const room = await first.management.create({}, context);
		const attached = await attach(first, room.sessionId);
		const generating = once(child, "message");
		const action = {
			type: "replace_asset" as const,
			designId: "simulated-room",
			expectedRevision: "1",
			expectedCatalogId: null,
			selectedProductId: "sofa-123",
			targetObjectId: "sofa-placed",
		};
		const accepted = await attached.controller.prompt({ message: "Keep my room design", action }, context);
		assert.equal(accepted.accepted, true);
		assert.deepEqual((await generating)[0], { type: "generating" });
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		await first.client.dispose();

		const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.8-flash" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			(request) => {
				assert.ok(
					request.systemPrompt?.includes(JSON.stringify(action)),
					"SQLite recovery must retain wire selection",
				);
				assert.ok(request.systemPrompt?.includes("Current request mutation block: true"));
				return fauxAssistantMessage("Recovered room design");
			},
		]);
		restarted = await startLiviServer({ dataDirectory, port: 0, models });
		assert.equal(restarted.serverId, ready.serverId);
		const recovered = await connect(restarted);
		connections.push(recovered);
		const session = await attach(recovered, room.sessionId);
		await eventually(
			() =>
				messages(session.transcript).includes("Recovered room design") &&
				session.transcript.state.value?.snapshot?.operation === null,
		);
		assert.deepEqual(messages(session.transcript), ["Keep my room design", "Recovered room design"]);
		assert.equal(faux.state.callCount, 1);
	},
);

test(
	"old unresolved history survives restart without locking or reconciling the room",
	{ timeout: 30_000 },
	async (t) => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "livi-studio-restart-"));
		const child = fork(new URL("./interrupted-studio.ts", import.meta.url), [dataDirectory], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		t.after(async () => {
			child.kill("SIGKILL");
			await rm(dataDirectory, { recursive: true, force: true });
		});
		const [saved] = (await once(child, "message")) as [{ type: string; sessionId: string }];
		assert.equal(saved.type, "saved-without-ack");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const evidence = JSON.parse(await readFile(join(dataDirectory, "simulated-adapter.json"), "utf8")) as {
			command: StudioCommand;
			result: Extract<StudioCommandResult, { status: "saved" }>;
			record: unknown;
		};
		const server = await startLiviServer({ dataDirectory, port: 0 });
		const client = await Client.connect({ serverId: server.serverId, transportFactory: transport(server.port) });
		const remote = createRemoteServiceBinding({
			services: [StudioConnection, StudioDirectory],
			transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
		});
		t.after(async () => {
			await remote.dispose(context);
			await client.dispose();
			await server.close();
		});
		const studio = remote.use(StudioConnection);
		const directory = remote.use(StudioDirectory);
		await remote.ready(context);
		const { generation } = await studio.register(
			{ ...evidence.command.binding, label: "Restarted fake Studio", contractVersion: 2 },
			context,
		);
		await studio.ready(generation, context);
		await studio.publishContext({ generation, sequence: 0, snapshot: evidence.result.snapshot }, context);
		await eventually(() => directory.state.value?.studios[0]?.phase === "ready");
		assert.deepEqual(studio.mailbox.value!.requests, [], "Restart must neither query old status nor resend an edit");
		await remote.dispose(context);
		await client.dispose();
		await server.close();
		const repo = new SqliteSessionRepo({
			directory: join(dataDirectory, "sessions"),
			databaseFactory: createNodeSqliteFactory(),
		});
		const metadata = (await repo.list(undefined, context)).find((item) => item.id === saved.sessionId)!;
		const session = await repo.open(metadata, context);
		const binding = await session.getValue(value("livi.studio.binding"), context);
		const records = await session.scanValues(value("livi.studio.command", ""), context);
		assert.deepEqual(binding?.value, evidence.command.binding);
		assert.equal(records.length, 1);
		assert.deepEqual(records[0]!.value, evidence.record, "Historical uncertainty must remain untouched");
		await session.close(context);
		await repo.close(context);
	},
);

test("bootstrap and WebSocket allow only same origin or configured exact Studio origins", async (t) => {
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-origins-"));
	const server = await startLiviServer({ dataDirectory, port: 0, studioAllowedOrigins: ["http://localhost:4000"] });
	t.after(async () => {
		await server.close();
		await rm(dataDirectory, { recursive: true, force: true });
	});
	const address = `http://127.0.0.1:${server.port}`;
	const allowed = await fetch(`${address}/api/bootstrap`, { headers: { origin: "http://localhost:4000" } });
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:4000");
	assert.equal(
		(await fetch(`${address}/api/bootstrap`, { headers: { origin: "http://localhost:4001" } })).status,
		403,
	);
	assert.equal((await fetch(`${address}/api/bootstrap`)).status, 200);
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: "http://localhost:4000" });
	await once(socket, "open");
	socket.terminate();
	const denied = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: "http://localhost:4001" });
	await once(denied, "error");
	await assert.rejects(
		startLiviServer({ dataDirectory, port: 0, studioAllowedOrigins: ["http://localhost:4000/path"] }),
		/exact HTTP/,
	);
});
