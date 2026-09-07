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
import { Transcript } from "./services/transcript.ts";
import { createTranscriptService } from "./services/transcript-provider.ts";

export interface DecoratorSessionOptions {
	session: Session;
	models?: Models;
	modelId?: string;
	apiKey?: string;
	onError?: (error: Error) => void;
}

export class DecoratorSession implements RoutedSessionHandle {
	readonly harness: AgentHarness;
	readonly lane: AgentLane;
	readonly controller: AgentController;
	private readonly transcript: ReturnType<typeof createTranscriptService>;
	private readonly attachments = new Set<RoutedSessionAttachment>();
	private readonly drives = new Map<string, Promise<void>>();
	private readonly onError: (error: Error) => void;
	private closing = false;
	private closePromise?: Promise<void>;

	private constructor(harness: AgentHarness, lane: AgentLane, options: DecoratorSessionOptions) {
		this.harness = harness;
		this.lane = lane;
		this.onError = options.onError ?? ((error) => console.error(error));
		this.transcript = createTranscriptService(lane, replicatedState);
		this.controller = {
			prompt: async (request, context) => {
				const result = await lane.accept({ kind: "prompt", prompt: request.message }, context);
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
		const { harness, open } = await AgentHarness.create(
			{
				session: options.session,
				models: registry,
				model,
				tools: [],
				activeToolNames: [],
				resources: {},
				systemPrompt:
					"You are Livi, a helpful assistant for general questions and interior decoration advice. Answer in the user’s language, using the information they supply.",
				compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
			},
			context,
		);
		let runtime: DecoratorSession | undefined;
		try {
			if (open.some((operation) => operation.lane !== "main"))
				throw new Error("Decorator sessions support only the main lane");
			const lane = await harness.lane("main", context);
			runtime = new DecoratorSession(harness, lane, options);
			await runtime.transcript.activate();
			for (const operation of open) {
				runtime.startDrive(operation.operationId);
			}
			return runtime;
		} catch (error) {
			if (runtime === undefined) await harness.close(BACKGROUND_CONTEXT);
			else await runtime.close(BACKGROUND_CONTEXT);
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
			.finally(() => {
				this.drives.delete(operationId);
			});
		this.drives.set(operationId, pending);
	}

	attachClient(): RoutedSessionAttachment {
		if (this.closing) throw new Error("Decorator session is closed");
		const provider = new RemoteServiceProvider([
			{ service: AgentController, mode: "singleton" },
			{ service: Transcript, mode: "singleton" },
		]);
		provider.provide(AgentController, this.controller);
		provider.provide(Transcript, this.transcript.service);
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
			for (const attachment of this.attachments) await attachment.release(context);
			await this.transcript.dispose();
			await this.harness.close(context);
			await Promise.all(this.drives.values());
		})();
		return this.closePromise;
	}
}
