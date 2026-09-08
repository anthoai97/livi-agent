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
import { AgentController } from "./services/agent-controller.ts";
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
	studio?: StudioBroker;
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
					const operationId = options.session.idGenerator.next(Date.now());
					await studio.journal.admit(operationId, context);
					try {
						const admitted = await lane.accept({ kind: "prompt", operationId, prompt: request.message }, context);
						if (!admitted.ok) await studio.journal.discardAdmission(operationId);
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
		const studio = new StudioSessionRuntime(options.session, options.studio);
		let harness: AgentHarness<StudioToolContext> | undefined;
		let runtime: DecoratorSession | undefined;
		try {
			await studio.activate();
			const tools = createStudioTools();
			const created = await AgentHarness.create<StudioToolContext>(
				{
					session: options.session,
					models: registry,
					model,
					tools,
					activeToolNames: tools.map((tool) => tool.name),
					toolExecution: "sequential",
					toolContext: async (context) => ({ studio, planning: await studio.context(undefined, context) }),
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
		const pending = this.lane
			.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT)
			.then((result) => {
				if (!result.ok) throw result.error;
			})
			.catch((error: unknown) => {
				if (!(this.closing && error instanceof HarnessClosed))
					this.onError(error instanceof Error ? error : new Error(String(error)));
			})
			.finally(async () => {
				await this.studio.journal.discardAdmission(operationId);
				this.drives.delete(operationId);
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
