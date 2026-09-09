import {
	type Context,
	createRemoteServiceEndpoint,
	RemoteServiceProvider,
	replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentHarness,
	type AgentLane,
	DEFAULT_COMPACTION_SETTINGS,
	HarnessClosed,
	type Session,
} from "@earendil-works/pi-agent-core";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { RoutedSessionAttachment, RoutedSessionHandle } from "@earendil-works/pi-server";
import { type CatalogAccess, unavailableCatalogAccess } from "./catalog.ts";
import { AgentController, type AgentPromptAction } from "./services/agent-controller.ts";
import { StudioSession } from "./services/studio.ts";
import { Transcript } from "./services/transcript.ts";
import { createTranscriptService } from "./services/transcript-provider.ts";
import type { StudioBroker } from "./studio-broker.ts";
import { StudioSessionRuntime } from "./studio-session.ts";
import { createStudioTools, type StudioToolContext, studioSystemPrompt } from "./studio-tools.ts";

export interface DecoratorSessionOptions {
	session: Session;
	models?: Models;
	modelId?: string;
	apiKey?: string;
	onError?: (error: Error) => void;
	onDebug?: (event: string, fields: Record<string, unknown>) => void;
	studio?: StudioBroker;
	catalog?: CatalogAccess;
}

export class DecoratorSession implements RoutedSessionHandle {
	readonly harness: AgentHarness<StudioToolContext>;
	readonly lane: AgentLane;
	readonly controller: AgentController;
	private readonly transcript: ReturnType<typeof createTranscriptService>;
	private readonly attachments = new Set<RoutedSessionAttachment>();
	private readonly drives = new Map<string, Promise<void>>();
	private readonly onError: (error: Error) => void;
	private closing = false;
	private closePromise?: Promise<void>;
	readonly studio: StudioSessionRuntime;

	private constructor(
		harness: AgentHarness<StudioToolContext>,
		lane: AgentLane,
		options: DecoratorSessionOptions,
		studio: StudioSessionRuntime,
	) {
		this.harness = harness;
		this.lane = lane;
		this.studio = studio;
		this.onError = options.onError ?? ((error) => console.error(error));
		this.transcript = createTranscriptService(lane, replicatedState);
		this.controller = {
			prompt: async (request, context) => {
				const result = await studio.exclusive(async () => {
					if (this.closing) throw new Error("Decorator session is closed");
					const parsed = parsePromptAction(request.action);
					if ("error" in parsed) {
						studio.debug("chat.rejected", {
							messageLength: request.message.length,
							errorCode: "invalid_message",
						});
						return { ok: false as const, error: { _tag: "InvalidMessage" as const, message: parsed.error } };
					}
					const operationId = options.session.idGenerator.next(Date.now());
					await studio.journal.admit(operationId, context, parsed.value, request.message);
					try {
						const admitted = await lane.accept({ kind: "prompt", operationId, prompt: request.message }, context);
						if (!admitted.ok) await studio.journal.discardAdmission(operationId);
						studio.debug(admitted.ok ? "chat.accepted" : "chat.rejected", {
							operationId,
							messageLength: request.message.length,
							errorCode: admitted.ok ? undefined : admitted.error._tag,
							actionType: parsed.value?.type,
						});
						return admitted;
					} catch (error) {
						// Admission may have committed even if its caller stopped waiting. Keep its pinned binding then.
						if ((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id !== operationId)
							await studio.journal.discardAdmission(operationId);
						throw error;
					}
				});
				if (!result.ok)
					return {
						accepted: false,
						operationId: null,
						error: {
							code:
								result.error._tag === "LaneBusy"
									? "lane_busy"
									: result.error._tag === "InvalidMessage"
										? "invalid_message"
										: "operation_failed",
							message: result.error.message,
						},
					};
				this.startDrive(result.value.operationId);
				return { accepted: true, operationId: result.value.operationId, error: null };
			},
			requestAbort: async (operationId, context) => {
				const result = await lane.requestAbort(operationId, context);
				if (!result.ok) throw result.error;
				studio.debug("chat.abort_requested", { operationId });
				await studio.journal.cancelPrepared(operationId);
				await studio.publish();
				this.startDrive(operationId);
			},
		};
	}

	static async create(
		options: DecoratorSessionOptions,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<DecoratorSession> {
		let registry = options.models;
		if (registry === undefined) {
			const models = createModels(
				options.apiKey === undefined
					? undefined
					: {
							authContext: {
								env: async (name) => (name === "GEMINI_API_KEY" ? options.apiKey : undefined),
								fileExists: async () => false,
							},
						},
			);
			models.setProvider(googleProvider());
			registry = models;
		}
		const model = registry.getModel("google", options.modelId ?? "gemini-3.5-flash-lite");
		if (!model) throw new Error(`Unknown Gemini model: ${options.modelId ?? "gemini-3.5-flash-lite"}`);
		const studio = new StudioSessionRuntime(options.session, options.studio, options.onDebug);
		let harness: AgentHarness<StudioToolContext> | undefined;
		let runtime: DecoratorSession | undefined;
		try {
			await studio.activate();
			const tools = createStudioTools();
			const catalog = options.catalog ?? unavailableCatalogAccess();
			const created = await AgentHarness.create<StudioToolContext>(
				{
					session: options.session,
					models: registry,
					model,
					tools,
					activeToolNames: tools.map((tool) => tool.name),
					toolExecution: "sequential",
					toolContext: async (context) => ({
						studio,
						planning: await studio.context(undefined, context),
						catalog,
					}),
					resources: {},
					systemPrompt: studioSystemPrompt,
					compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
				},
				context,
			);
			harness = created.harness;
			const { open } = created;
			if (open.some((operation) => operation.lane !== "main"))
				throw new Error("Decorator sessions support only the main lane");
			const lane = await harness.lane("main", context);
			await lane.setActiveTools(
				tools.map((tool) => tool.name),
				context,
			);
			runtime = new DecoratorSession(harness, lane, options, studio);
			await runtime.transcript.activate();
			for (const operation of open) {
				await studio.journal.blockMutations(operation.operationId);
				studio.debug("mutation.blocked", {
					operationId: operation.operationId,
					mutationBlocked: true,
					cause: "recovered_operation",
				});
				runtime.startDrive(operation.operationId);
			}
			return runtime;
		} catch (error) {
			if (runtime === undefined) {
				await studio.close();
				await harness?.close(BACKGROUND_CONTEXT);
			} else await runtime.close(BACKGROUND_CONTEXT);
			throw error;
		}
	}

	private startDrive(operationId: string): void {
		if (this.closing || this.drives.has(operationId)) return;
		let settled = false;
		const pending = this.lane
			.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT)
			.then((result) => {
				if (!result.ok) throw result.error;
				if (result.value.kind === "settled") {
					settled = true;
					const { status, error } = result.value.outcome;
					this.studio.debug(status === "aborted" ? "chat.aborted" : "chat.finished", {
						operationId,
						status,
						errorCode: error?.code,
					});
				}
			})
			.catch((error: unknown) => {
				this.studio.debug("chat.error", {
					operationId,
					cause: this.closing ? "session_closing" : "drive_failed",
					errorType: error instanceof Error ? error.name : "NonError",
				});
				if (!(this.closing && error instanceof HarnessClosed))
					this.onError(error instanceof Error ? error : new Error(String(error)));
			})
			.finally(async () => {
				this.drives.delete(operationId);
				if (settled && !this.closing) await this.studio.journal.discardAdmission(operationId);
			});
		this.drives.set(operationId, pending);
	}

	attachClient(): RoutedSessionAttachment {
		if (this.closing) throw new Error("Decorator session is closed");
		const provider = new RemoteServiceProvider([
			{ service: AgentController, mode: "singleton" },
			{ service: Transcript, mode: "singleton" },
			{ service: StudioSession, mode: "singleton" },
		]);
		provider.provide(AgentController, this.controller);
		provider.provide(Transcript, this.transcript.service);
		provider.provide(StudioSession, this.studio.service);
		const endpoint = createRemoteServiceEndpoint(provider);
		let released = false;
		const attachment: RoutedSessionAttachment = {
			invokeService: (call, publish, context) => {
				if (released) return Promise.reject(new Error("Session attachment is released"));
				return endpoint.invoke(call, publish, context);
			},
			release: () => {
				if (released) return;
				released = true;
				endpoint.dispose();
				provider.dispose();
				this.attachments.delete(attachment);
			},
		};
		this.attachments.add(attachment);
		return attachment;
	}

	close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		this.closing = true;
		this.closePromise ??= (async () => {
			await this.studio.close();
			for (const attachment of this.attachments) await attachment.release(context);
			await this.transcript.dispose();
			await this.harness.close(context);
			await Promise.all(this.drives.values());
		})();
		return this.closePromise;
	}
}

function requiredId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parsePromptAction(action: unknown): { value: AgentPromptAction | null } | { error: string } {
	if (action === undefined) return { value: null };
	if (action === null || typeof action !== "object" || Array.isArray(action))
		return { error: "action must be an add_asset or replace_asset object" };
	const record = action as Record<string, unknown>;
	if (record.type === "add_asset") {
		if (!requiredId(record.selectedProductId)) return { error: "add_asset requires selectedProductId" };
		if (typeof record.quantity !== "number" || !Number.isSafeInteger(record.quantity) || record.quantity < 1)
			return { error: "add_asset quantity must be a positive integer" };
		return {
			value: { type: "add_asset", selectedProductId: record.selectedProductId, quantity: record.quantity },
		};
	}
	if (record.type === "replace_asset") {
		if (!requiredId(record.selectedProductId)) return { error: "replace_asset requires selectedProductId" };
		if (!requiredId(record.targetObjectId)) return { error: "replace_asset requires targetObjectId" };
		return {
			value: {
				type: "replace_asset",
				selectedProductId: record.selectedProductId,
				targetObjectId: record.targetObjectId,
			},
		};
	}
	return { error: "action type must be add_asset or replace_asset" };
}
