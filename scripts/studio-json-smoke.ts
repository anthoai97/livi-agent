import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startLiviServer } from "../livi-server/src/server.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../packages/ai/dist/index.js";
import { BACKGROUND_CONTEXT as context } from "../packages/chord/dist/context/index.js";
import { createRemoteServiceBinding } from "../packages/chord/dist/index.js";
import { createClientServiceTransport } from "../packages/client/dist/index.js";
import {
	AgentController,
	type AgentOperationResponse,
	SessionManagement,
	type StudioCommand,
	StudioDirectory,
	StudioSession,
	type StudioTransform,
	Transcript,
} from "../packages/decorator-agent/dist/contracts.js";
import { JsonStudioAdapter } from "./studio-smoke/adapter.js";
import { type AssertionResult, assertJson, type JsonAssertion } from "./studio-smoke/assertions.js";
import { connectClient, eventually } from "./studio-smoke/connection.js";
import { readRoom } from "./studio-smoke/room.js";

interface Scenario {
	id: string;
	prompt: string;
	selectedObjectIds: string[];
	injected: {
		text: string;
		call?: { name: string; arguments: Record<string, unknown>; originalCommandFrom?: string };
	};
	reopenBefore?: boolean;
	manualEdit?: { objectId: string; transform: Partial<StudioTransform> };
	stop?: "before_dispatch" | "after_dispatch";
	dropReplyAndRestart?: boolean;
	reloadAdapterAfter?: boolean;
	expect: {
		commands: {
			action: "move" | "rotate" | "remove";
			objectId: string;
			position?: number[];
			rotation?: number[];
			status: "saved" | "rejected";
		}[];
		json: JsonAssertion[];
		textIncludes?: string[];
		toolErrorIncludes?: string;
	};
}

const { values } = parseArgs({
	options: {
		room: { type: "string" },
		cases: { type: "string" },
		mode: { type: "string", default: "injected" },
		report: { type: "string" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(
		"pnpm smoke:studio --room <mapped-export.json> --cases <scenarios.json> [--mode injected|real] [--report <report.json>]\nUses a temporary local JSON copy and real server services. Studio saves are simulated. Real mode uses server-only GEMINI_API_KEY.",
	);
} else {
	if (!values.room || !values.cases || (values.mode !== "injected" && values.mode !== "real"))
		throw new Error("Supply --room and --cases; --mode must be injected or real. Use --help for usage.");
	const fixture = await readRoom(resolve(values.room));
	const scenarioFile = JSON.parse(await readFile(resolve(values.cases), "utf8")) as { scenarios: Scenario[] };
	if (!Array.isArray(scenarioFile.scenarios) || !scenarioFile.scenarios.length)
		throw new Error("Scenario file needs a nonempty scenarios array");
	const ids = new Set<string>();
	for (const scenario of scenarioFile.scenarios) {
		if (
			!scenario.id ||
			ids.has(scenario.id) ||
			typeof scenario.prompt !== "string" ||
			!Array.isArray(scenario.selectedObjectIds) ||
			!Array.isArray(scenario.expect?.commands) ||
			!Array.isArray(scenario.expect?.json)
		)
			throw new Error("Each scenario needs unique id, prompt, selection and independent expected commands/JSON");
		ids.add(scenario.id);
		for (const assertion of scenario.expect.json) {
			if (
				typeof assertion.path !== "string" ||
				[assertion.unchanged === true, assertion.absent === true, Object.hasOwn(assertion, "equals")].filter(
					Boolean,
				).length !== 1 ||
				(assertion.tolerance !== undefined && (!Number.isFinite(assertion.tolerance) || assertion.tolerance < 0))
			)
				throw new Error(`Invalid JSON assertion in ${scenario.id}`);
		}
	}
	if (values.mode === "real" && !process.env.GEMINI_API_KEY)
		throw new Error("Real mode requires server-only GEMINI_API_KEY; no model verification was performed");
	const directory = await mkdtemp(join(tmpdir(), "livi-studio-smoke-"));
	const reportPath = resolve(values.report ?? "artifacts/studio-smoke.json");
	const faux =
		values.mode === "injected"
			? fauxProvider({ provider: "google", models: [{ id: "gemini-3.5-flash-lite" }] })
			: undefined;
	const models = faux ? createModels() : undefined;
	if (faux) models!.setProvider(faux.provider);
	const errors: string[] = [];
	const serverOptions = {
		dataDirectory: join(directory, "server"),
		port: 0,
		models,
		modelId: values.mode === "real" ? process.env.GEMINI_MODEL : undefined,
		apiKey: values.mode === "real" ? process.env.GEMINI_API_KEY : undefined,
		onError: (error: Error) => errors.push(error.message),
	};
	let server = await startLiviServer(serverOptions);
	let adapter = new JsonStudioAdapter(join(directory, "studio-state.json"), "smoke-primary");
	await adapter.load(fixture.snapshot);
	const other = new JsonStudioAdapter(join(directory, "other-studio-state.json"), "smoke-secondary");
	await other.load({ ...structuredClone(fixture.snapshot), designId: `${fixture.snapshot.designId}:isolated` });
	const otherBefore = other.snapshot;

	async function connectChat(sessionId?: string) {
		const client = await connectClient(server);
		const binding = createRemoteServiceBinding({
			services: [SessionManagement, StudioDirectory],
			transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
		});
		await binding.ready(context);
		const management = binding.use(SessionManagement);
		const id = sessionId ?? (await management.create({}, context)).sessionId;
		await management.attach(id, context);
		const target = client.attachment;
		const sessionBinding = createRemoteServiceBinding({
			services: [AgentController, Transcript, StudioSession],
			transport: createClientServiceTransport(client, () => target),
		});
		await sessionBinding.ready(context);
		return {
			id,
			client,
			binding,
			sessionBinding,
			directory: binding.use(StudioDirectory),
			controller: sessionBinding.use(AgentController),
			transcript: sessionBinding.use(Transcript),
			studio: sessionBinding.use(StudioSession),
			async close() {
				await sessionBinding.dispose(context);
				await binding.dispose(context);
				await client.dispose();
			},
		};
	}
	let chat: Awaited<ReturnType<typeof connectChat>> | undefined;
	const report: {
		mode: string;
		provenance: string;
		sourceDescription: string;
		persistence: string;
		acceptance: string;
		stateDirectory: string;
		scenarios: Record<string, unknown>[];
		assertions: AssertionResult[];
		errors: string[];
		passed: boolean;
	} = {
		mode: values.mode,
		provenance: fixture.provenance,
		sourceDescription: fixture.sourceDescription,
		persistence: "simulated atomic local JSON; agent chat uses real SQLite",
		acceptance:
			"Real Studio editor/backend and joint issue #7 acceptance pending. Synthetic fixtures do not establish database-export acceptance.",
		stateDirectory: directory,
		scenarios: [],
		assertions: [],
		errors,
		passed: false,
	};
	const commandsByScenario = new Map<string, StudioCommand>();
	let releaseScenario: (() => void) | undefined;
	try {
		await adapter.connect(server);
		await other.connect(server);
		chat = await connectChat();
		await eventually(
			() => chat!.directory.state.value?.studios.filter((studio) => studio.phase === "ready").length === 2,
			"both Studios ready",
		);
		await chat.studio.bind({ designId: fixture.snapshot.designId, tabId: adapter.tabId }, context);
		await eventually(() => chat!.studio.state.value?.phase === "ready", "attached Studio ready");
		for (const scenario of scenarioFile.scenarios) {
			if (values.mode === "real" && (scenario.stop || scenario.dropReplyAndRestart)) {
				report.scenarios.push({
					id: scenario.id,
					skipped: "Timing fault injection is deterministic-mode coverage; run --mode injected",
				});
				continue;
			}
			if (scenario.reopenBefore) {
				const sessionId = chat.id;
				await chat.close();
				chat = await connectChat(sessionId);
				await eventually(() => chat!.studio.state.value?.phase === "ready", "binding hydration after reopen");
			}
			if (scenario.manualEdit) await adapter.manualEdit(scenario.manualEdit.objectId, scenario.manualEdit.transform);
			await adapter.select(scenario.selectedObjectIds);
			const before = adapter.snapshot;
			const emittedStart = adapter.emitted.length;
			const savesBefore = adapter.saveCount;
			const transcriptBefore = chat.transcript.state.value?.snapshot?.transcript.length ?? 0;
			const modelStarted = Promise.withResolvers<void>();
			const modelRelease = Promise.withResolvers<void>();
			const dispatchStarted = Promise.withResolvers<void>();
			const dispatchRelease = Promise.withResolvers<void>();
			releaseScenario = () => {
				modelRelease.resolve();
				dispatchRelease.resolve();
			};
			if (faux) {
				const injected = scenario.injected;
				if (!injected || typeof injected.text !== "string")
					throw new Error(`Missing injected model script for ${scenario.id}`);
				const call = injected.call;
				const args = structuredClone(call?.arguments ?? {});
				if (call?.originalCommandFrom) {
					const original = commandsByScenario.get(call.originalCommandFrom);
					if (!original) throw new Error(`Missing earlier command ${call.originalCommandFrom}`);
					args.originalCommandId = original.commandId;
				}
				faux.setResponses([
					async (request) => {
						assert.deepEqual(
							request.tools?.map((tool) => tool.name).sort(),
							[
								"get_product_details",
								"get_room_context",
								"move_object",
								"remove_object",
								"rotate_object",
								"search_catalog",
							],
							"Exactly the supported tools must be active on each new generation",
						);
						modelStarted.resolve();
						if (scenario.stop === "before_dispatch") await modelRelease.promise;
						return call
							? fauxAssistantMessage(fauxToolCall(call.name, args), { stopReason: "toolUse" })
							: fauxAssistantMessage(injected.text);
					},
					...(call && !scenario.stop ? [fauxAssistantMessage(injected.text)] : []),
				]);
			}
			adapter.dropNextReply = Boolean(scenario.dropReplyAndRestart);
			adapter.beforeExecute =
				scenario.stop === "after_dispatch"
					? async () => {
							dispatchStarted.resolve();
							await dispatchRelease.promise;
						}
					: undefined;
			const accepted: AgentOperationResponse = await chat.controller.prompt({ message: scenario.prompt }, context);
			if (!accepted.accepted) throw new Error(`Prompt admission ${scenario.id}: ${accepted.error.message}`);
			if (scenario.stop === "before_dispatch") {
				await Promise.race([
					modelStarted.promise,
					new Promise((_, reject) => setTimeout(() => reject(new Error("Model never started")), 20_000).unref()),
				]);
				await chat.controller.requestAbort(accepted.operationId, context);
				modelRelease.resolve();
			}
			if (scenario.stop === "after_dispatch") {
				await Promise.race([
					dispatchStarted.promise,
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("Command never dispatched")), 20_000).unref(),
					),
				]);
				await chat.controller.requestAbort(accepted.operationId, context);
				dispatchRelease.resolve();
			}
			if (scenario.dropReplyAndRestart) {
				await eventually(() => adapter.saveCount > savesBefore, "simulated save before dropped reply");
				await adapter.disconnect();
			}
			await eventually(
				() =>
					chat!.transcript.state.value?.snapshot?.lastResult?.operationId === accepted.operationId &&
					chat!.transcript.state.value?.snapshot?.operation === null,
				`turn completion ${scenario.id}`,
				values.mode === "real" ? 120_000 : 20_000,
			);
			const turnResult = chat.transcript.state.value?.snapshot?.lastResult;
			const emitted = adapter.emitted.slice(emittedStart);
			if (emitted[0]) commandsByScenario.set(scenario.id, emitted[0]);
			if (scenario.dropReplyAndRestart || scenario.reloadAdapterAfter) {
				const sessionId = chat.id;
				await adapter.disconnect();
				if (scenario.dropReplyAndRestart) {
					await chat.close();
					await other.disconnect();
					await server.close();
					server = await startLiviServer(serverOptions);
					await other.connect(server);
				}
				adapter = new JsonStudioAdapter(join(directory, "studio-state.json"), "smoke-primary");
				await adapter.load(fixture.snapshot);
				await adapter.connect(server);
				if (scenario.dropReplyAndRestart) chat = await connectChat(sessionId);
				await eventually(
					() => chat!.studio.state.value?.phase === "ready",
					"Studio ready after local state reload",
				);
			}
			if (scenario.stop === "after_dispatch")
				await eventually(
					() => emitted.every((command) => Boolean(adapter.results[command.commandId])),
					"simulated Studio finishes the already-dispatched command after Stop",
				);
			const after = adapter.snapshot;
			const entries = chat.transcript.state.value?.snapshot?.transcript.slice(transcriptBefore) ?? [];
			const text = entries
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
						: [],
				)
				.join("\n");
			const toolResults = entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
			);
			const assertions = assertJson(before, after, scenario.expect.json);
			if (scenario.dropReplyAndRestart || scenario.reloadAdapterAfter)
				assertions.push({
					assertion: "reload reads current context without resubmitting commands",
					passed: adapter.emitted.length === 0,
					expected: 0,
					actual: adapter.emitted.length,
				});
			assertions.push({
				assertion: "model turn completed or explicitly stopped",
				passed: turnResult?.status === (scenario.stop ? "aborted" : "completed"),
				expected: scenario.stop ? "aborted" : "completed",
				actual: turnResult,
			});
			const actualCommands = emitted.map((command) => ({
				action: command.action.type,
				objectId: command.objectId,
				...(command.action.type === "move"
					? { position: command.action.position }
					: command.action.type === "rotate"
						? { rotation: command.action.rotation }
						: {}),
				status: adapter.results[command.commandId]?.result.status,
			}));
			assertions.push(
				...assertJson(null, actualCommands, [{ path: "", equals: scenario.expect.commands, tolerance: 0.000001 }]),
			);
			// All fields outside independently declared expected mutations must survive byte-for-value.
			const preservedBefore = structuredClone(before);
			const preservedAfter = structuredClone(after);
			for (const expected of scenario.expect.commands.filter((command) => command.status === "saved")) {
				if (expected.action === "remove") {
					preservedBefore.objects = preservedBefore.objects.filter((object) => object.id !== expected.objectId);
					preservedBefore.selectedObjectIds = preservedBefore.selectedObjectIds.filter(
						(id) => id !== expected.objectId,
					);
				} else {
					const object = preservedBefore.objects.find((object) => object.id === expected.objectId);
					const savedObject = preservedAfter.objects.find((object) => object.id === expected.objectId);
					const field = expected.action === "move" ? "position" : "rotation";
					assertions.push(
						...assertJson(null, savedObject?.[field], [
							{ path: "", equals: expected[field], tolerance: field === "position" ? 0.0001 : 0.000001 },
						]),
					);
					if (object && savedObject) {
						object[field] = expected[field] as [number, number, number];
						savedObject[field] = expected[field] as [number, number, number];
					}
				}
			}
			if (scenario.expect.commands.some((command) => command.status === "saved"))
				preservedBefore.revision = preservedAfter.revision;
			assertions.push(...assertJson(preservedBefore, preservedAfter, [{ path: "", unchanged: true }]));
			for (const phrase of scenario.expect.textIncludes ?? [])
				assertions.push({
					assertion: `grounded response contains ${phrase}`,
					passed: text.toLowerCase().includes(phrase.toLowerCase()),
					expected: phrase,
					actual: text,
				});
			if (scenario.expect.toolErrorIncludes && values.mode === "injected")
				assertions.push({
					assertion: "structured tool rejection",
					passed: JSON.stringify(toolResults).includes(scenario.expect.toolErrorIncludes),
					expected: scenario.expect.toolErrorIncludes,
					actual: toolResults,
				});
			assertions.push({
				assertion: "one simulated save per expected saved command",
				passed:
					adapter.saveCount - savesBefore ===
					scenario.expect.commands.filter((command) => command.status === "saved").length,
				expected: scenario.expect.commands.filter((command) => command.status === "saved").length,
				actual: adapter.saveCount - savesBefore,
			});
			assertions.push(...assertJson(otherBefore, other.snapshot, [{ path: "", unchanged: true }]));
			assertions.push({
				assertion: "second Studio received no commands",
				passed: other.emitted.length === 0,
				expected: 0,
				actual: other.emitted.length,
			});
			report.scenarios.push({
				id: scenario.id,
				prompt: scenario.prompt,
				selectedObjectIds: scenario.selectedObjectIds,
				commands: emitted,
				before,
				after,
				revision: after.revision,
				turnResult,
				text,
				toolResults,
				savedResults: emitted.map((command) => adapter.results[command.commandId]?.result),
				assertions,
				passed: assertions.every((assertion) => assertion.passed),
			});
			report.assertions.push(
				...assertions.map((assertion) => ({ ...assertion, assertion: `${scenario.id}: ${assertion.assertion}` })),
			);
			if (assertions.some((assertion) => !assertion.passed))
				throw new Error(`Independent assertions failed: ${scenario.id}`);
		}
		errors.push(...adapter.errors, ...other.errors);
		report.passed = errors.length === 0 && report.assertions.every((assertion) => assertion.passed);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		releaseScenario?.();
		await chat?.close().catch((error: unknown) => errors.push(String(error)));
		await adapter.disconnect().catch((error: unknown) => errors.push(String(error)));
		await other.disconnect().catch((error: unknown) => errors.push(String(error)));
		await server.close().catch((error: unknown) => errors.push(String(error)));
		report.passed &&= errors.length === 0;
		await mkdir(dirname(reportPath), { recursive: true });
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(
			JSON.stringify({
				passed: report.passed,
				mode: report.mode,
				provenance: report.provenance,
				persistence: report.persistence,
				scenarios: report.scenarios.length,
				report: reportPath,
				stateDirectory: directory,
				errors,
			}),
		);
		if (!report.passed) process.exitCode = 1;
	}
}
