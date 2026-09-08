import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Context, replicatedState } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	StudioBinding,
	StudioCommand,
	StudioCommandResult,
	StudioConnection,
	StudioContextUpdate,
	StudioErrorCode,
	StudioMailboxRequest,
	StudioMailboxState,
	StudioPhase,
	StudioResponse,
	StudioSnapshot,
} from "./services/studio.ts";
import { STUDIO_CONTRACT_VERSION } from "./services/studio.ts";

export class StudioBrokerError extends Error {
	readonly code: StudioErrorCode;
	constructor(code: StudioErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
interface Connection {
	binding: StudioBinding;
	label: string;
	generation: string;
	sequence: number;
	phase: StudioPhase;
	snapshot: StudioSnapshot | null;
	subscribed: boolean;
	fresh: boolean;
	mailbox: ReturnType<typeof replicatedState<StudioMailboxState>>;
}
interface TrackedCommand {
	command: StudioCommand;
	onResult(result: StudioCommandResult): Promise<void>;
}
interface Pending {
	connection: Connection;
	request: StudioMailboxRequest;
	resolve(response: StudioResponse): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** Application routing only. Durable ownership and results remain in Session values. */
export class StudioBroker {
	readonly directory = replicatedState<{
		studios: { designId: string; tabId: string; label: string; phase: StudioPhase }[];
	}>({ studios: [] });
	private readonly connections = new Map<string, Connection>();
	private readonly claims = new Map<string, StudioBinding>();
	private readonly commands = new Map<string, TrackedCommand>();
	private readonly pending = new Map<string, Pending>();
	private readonly responses = new Map<string, { connection: Connection; response: StudioResponse }>();
	private readonly results = new Map<string, StudioCommandResult>();
	private readonly publishedCommands = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private readonly deliveries = new Set<Promise<void>>();
	private closed = false;
	private readonly timeoutMs: number;
	constructor(options: { timeoutMs?: number } = {}) {
		this.timeoutMs = options.timeoutMs ?? 15_000;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private notify(): void {
		this.directory.state.studios = [...this.connections.values()].map(({ binding, label, phase }) => ({
			...binding,
			label,
			phase,
		}));
		this.directory.publish(BACKGROUND_CONTEXT);
		for (const listener of this.listeners) listener();
	}
	getState(binding: StudioBinding | null): { phase: StudioPhase; snapshot: StudioSnapshot | null; busy: boolean } {
		const connection = binding ? this.connections.get(binding.tabId) : undefined;
		return {
			phase: connection?.binding.designId === binding?.designId ? (connection?.phase ?? "offline") : "offline",
			snapshot:
				connection?.binding.designId === binding?.designId ? structuredClone(connection?.snapshot ?? null) : null,
			busy:
				binding !== null &&
				[...this.commands.values()].some(({ command }) => command.binding.designId === binding.designId),
		};
	}
	claim(conversationId: string, binding: StudioBinding | null): void {
		const previous = this.claims.get(conversationId);
		if (previous?.designId === binding?.designId && previous?.tabId === binding?.tabId) return;
		if ([...this.commands.values()].some(({ command }) => command.conversationId === conversationId))
			throw new StudioBrokerError("design_busy", "Resolve the previous room action before changing its target");
		if (
			binding &&
			[...this.claims].some(([id, claimed]) => id !== conversationId && claimed.designId === binding.designId)
		)
			throw new StudioBrokerError("design_busy", "Another conversation controls this design");
		if (binding) this.claims.set(conversationId, structuredClone(binding));
		else this.claims.delete(conversationId);
		this.notify();
	}
	track(command: StudioCommand, onResult: TrackedCommand["onResult"]): void {
		const existing = this.commands.get(command.commandId);
		if (existing && JSON.stringify(existing.command) !== JSON.stringify(command))
			throw new StudioBrokerError("conflicting_result", "Command identity has a different immutable payload");
		if (
			[...this.commands.values()].some(
				(item) =>
					item.command.binding.designId === command.binding.designId &&
					item.command.commandId !== command.commandId,
			)
		)
			throw new StudioBrokerError("design_busy", "A previous command for this design is unresolved");
		this.commands.set(command.commandId, { command: structuredClone(command), onResult });
		this.notify();
	}
	release(commandId: string): void {
		this.commands.delete(commandId);
		for (const connection of this.connections.values())
			if (
				connection.phase === "reconciling" &&
				connection.fresh &&
				![...this.commands.values()].some(({ command }) => command.binding.designId === connection.binding.designId)
			)
				connection.phase = "ready";
		this.notify();
	}

	/** A new instance is provided to each physical connection; no caller-supplied identity grants authority. */
	attach(): { service: StudioConnection; release(): void } {
		const mailbox = replicatedState<StudioMailboxState>({ requests: [] });
		let connection: Connection | undefined;
		let released = false;
		const authorize = (generation: string): Connection => {
			if (
				released ||
				!connection ||
				this.closed ||
				connection.generation !== generation ||
				this.connections.get(connection.binding.tabId) !== connection
			)
				throw new StudioBrokerError("wrong_binding", "Retired or unregistered Studio connection");
			return connection;
		};
		return {
			service: {
				mailbox,
				register: async (registration) => {
					if (released || this.closed || connection)
						throw new StudioBrokerError("wrong_binding", "Connection is already registered or closed");
					if (
						registration.contractVersion !== STUDIO_CONTRACT_VERSION ||
						!registration.tabId ||
						!registration.designId ||
						typeof registration.label !== "string"
					)
						throw new StudioBrokerError("invalid_arguments", "Invalid Studio registration");
					const previous = this.connections.get(registration.tabId);
					if (previous && previous.phase !== "offline")
						throw new StudioBrokerError("wrong_binding", "This tab already has an active connection");
					connection = {
						binding: { designId: registration.designId, tabId: registration.tabId },
						label: registration.label,
						generation: randomUUID(),
						sequence: -1,
						phase: "reconciling",
						snapshot: null,
						subscribed: false,
						fresh: false,
						mailbox,
					};
					this.connections.set(registration.tabId, connection);
					this.notify();
					return { generation: connection.generation };
				},
				ready: async (generation) => {
					const current = authorize(generation);
					if (current.subscribed) return;
					current.subscribed = true;
					// Returning immediately lets the adapter consume and answer handshake mailbox requests.
					const work = this.reconcile(current.binding)
						.catch(() => {})
						.finally(() => this.deliveries.delete(work));
					this.deliveries.add(work);
				},
				publishContext: async (update) => {
					this.applyContext(authorize(update.generation), update);
				},
				publishSelection: async (update) => {
					const current = authorize(update.generation);
					if (!Number.isSafeInteger(update.sequence) || update.sequence < 0)
						throw new StudioBrokerError("invalid_arguments", "Invalid selection sequence");
					if (update.sequence <= current.sequence) return;
					if (
						!current.snapshot ||
						!Array.isArray(update.selectedObjectIds) ||
						update.selectedObjectIds.some((id) => !current.snapshot?.objects.some((object) => object.id === id))
					)
						throw new StudioBrokerError("invalid_target", "Selection must identify objects in the current scene");
					current.sequence = update.sequence;
					current.snapshot.selectedObjectIds = [...update.selectedObjectIds];
					this.notify();
				},
				respond: async (response) => {
					const current = authorize(response.generation);
					const pending = this.pending.get(response.requestId);
					if (!pending) {
						const previous = this.responses.get(response.requestId);
						if (previous?.connection === current) {
							if (isDeepStrictEqual(previous.response, response)) return;
							throw new StudioBrokerError("conflicting_result", "Conflicting duplicate response");
						}
					}
					if (!pending || pending.connection !== current)
						throw new StudioBrokerError("wrong_binding", "Response does not belong to this connection's request");
					const work = this.respond(current, pending, response);
					this.deliveries.add(work);
					try {
						await work;
					} finally {
						this.deliveries.delete(work);
					}
				},
			},
			release: () => {
				if (released) return;
				released = true;
				if (!connection || this.connections.get(connection.binding.tabId) !== connection) return;
				connection.phase = "offline";
				connection.subscribed = false;
				connection.snapshot = null;
				for (const [id, response] of this.responses)
					if (response.connection === connection) this.responses.delete(id);
				for (const [id, pending] of this.pending)
					if (pending.connection === connection)
						this.finish(id, new StudioBrokerError("studio_unavailable", "Studio disconnected"));
				mailbox.state.requests = [];
				mailbox.publish(BACKGROUND_CONTEXT);
				this.notify();
			},
		};
	}
	private applyContext(connection: Connection, update: StudioContextUpdate): void {
		if (update.generation !== connection.generation || update.snapshot.designId !== connection.binding.designId)
			throw new StudioBrokerError("wrong_binding", "Context belongs to another registration or design");
		if (!Number.isSafeInteger(update.sequence) || update.sequence < 0)
			throw new StudioBrokerError("invalid_arguments", "Invalid scene sequence");
		if (update.sequence <= connection.sequence) return;
		validateStudioSnapshot(update.snapshot);
		connection.sequence = update.sequence;
		connection.snapshot = structuredClone(update.snapshot);
		this.notify();
	}
	private async respond(connection: Connection, pending: Pending, response: StudioResponse): Promise<void> {
		if (response.type === "context") {
			if (pending.request.type !== "context")
				throw new StudioBrokerError("invalid_arguments", "Unexpected context response");
			this.applyContext(connection, response.context);
		} else if (response.type === "result") {
			const commandId =
				pending.request.type === "execute"
					? pending.request.command.commandId
					: pending.request.type === "status"
						? pending.request.commandId
						: undefined;
			if (commandId !== response.result.commandId)
				throw new StudioBrokerError("wrong_binding", "Result command does not match the request");
			const tracked = commandId ? this.commands.get(commandId) : undefined;
			const previous = commandId ? this.results.get(commandId) : undefined;
			if (previous && !isDeepStrictEqual(previous, response.result))
				throw new StudioBrokerError("conflicting_result", "Conflicting authoritative command result");
			if (response.result.status === "saved") {
				validateStudioSnapshot(response.result.snapshot);
				if (
					response.result.snapshot.designId !== connection.binding.designId ||
					response.result.revision !== response.result.snapshot.revision
				)
					throw new StudioBrokerError("wrong_binding", "Saved evidence has a different design or revision");
			}
			// Save immutable evidence before acknowledging success. Cancellation only detaches a waiter.
			if (tracked) await tracked.onResult(structuredClone(response.result));
			if (response.result.status === "saved" || response.result.status === "rejected")
				this.results.set(response.result.commandId, structuredClone(response.result));
			if (response.context) this.applyContext(connection, response.context);
		} else if (response.type !== "error") throw new StudioBrokerError("invalid_arguments", "Invalid response");
		this.responses.set(response.requestId, { connection, response: structuredClone(response) });
		this.finish(response.requestId, response);
	}
	private finish(id: string, result: StudioResponse | Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		pending.connection.mailbox.state.requests = pending.connection.mailbox.state.requests.filter(
			(request) => request.requestId !== id,
		);
		pending.connection.mailbox.publish(BACKGROUND_CONTEXT);
		if (result instanceof Error) pending.reject(result);
		else pending.resolve(result);
	}
	private connection(binding: StudioBinding): Connection {
		const connection = this.connections.get(binding.tabId);
		if (this.closed || !connection || connection.phase === "offline" || !connection.subscribed)
			throw new StudioBrokerError("studio_unavailable", "Studio is not connected");
		if (connection.binding.designId !== binding.designId)
			throw new StudioBrokerError("wrong_binding", "Studio is showing a different design");
		return connection;
	}
	private request(
		connection: Connection,
		payload:
			| { type: "context" }
			| { type: "execute"; command: StudioCommand }
			| { type: "status"; commandId: string },
		context: Context,
	): Promise<StudioResponse> {
		context.abortSignal?.throwIfAborted();
		const request: StudioMailboxRequest = {
			...payload,
			requestId: randomUUID(),
			generation: connection.generation,
			binding: structuredClone(connection.binding),
		};
		const promise = new Promise<StudioResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new StudioBrokerError(
					payload.type === "context" ? "studio_unavailable" : "outcome_unknown",
					"Studio response timed out",
				);
				if (payload.type === "context") this.finish(request.requestId, error);
				else reject(error); // Preserve correlation for a late durable acknowledgement.
			}, this.timeoutMs);
			this.pending.set(request.requestId, { connection, request, resolve, reject, timer });
			connection.mailbox.state.requests = [...connection.mailbox.state.requests, request];
			connection.mailbox.publish(BACKGROUND_CONTEXT);
		});
		return awaitWithContext(promise, context);
	}
	async freshContext(binding: StudioBinding, context: Context = BACKGROUND_CONTEXT): Promise<StudioSnapshot> {
		const connection = this.connection(binding);
		const response = await this.request(connection, { type: "context" }, context);
		if (response.type === "error") throw new StudioBrokerError(response.error.code, response.error.message);
		if (response.type !== "context" || !connection.snapshot)
			throw new StudioBrokerError("studio_unavailable", "Studio did not provide saved context");
		return structuredClone(connection.snapshot);
	}
	async execute(command: StudioCommand, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandResult> {
		const connection = this.connection(command.binding);
		if (connection.phase !== "ready")
			throw new StudioBrokerError("studio_unavailable", "Studio is reconciling previous actions");
		const claim = this.claims.get(command.conversationId);
		if (!claim || claim.designId !== command.binding.designId || claim.tabId !== command.binding.tabId)
			throw new StudioBrokerError("wrong_binding", "Conversation does not control the pinned design");
		const tracked = this.commands.get(command.commandId);
		if (!tracked || JSON.stringify(tracked.command) !== JSON.stringify(command))
			throw new StudioBrokerError("outcome_unknown", "Command must be durably tracked before publication");
		if (this.publishedCommands.has(command.commandId))
			throw new StudioBrokerError(
				"outcome_unknown",
				"Already published; obtain durable status instead of resending",
			);
		context.abortSignal?.throwIfAborted();
		this.publishedCommands.add(command.commandId);
		const response = await this.request(connection, { type: "execute", command: structuredClone(command) }, context);
		if (response.type === "error") throw new StudioBrokerError(response.error.code, response.error.message);
		if (response.type !== "result") throw new StudioBrokerError("outcome_unknown", "Missing mutation outcome");
		return response.result;
	}
	async status(command: StudioCommand, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandResult> {
		const response = await this.request(
			this.connection(command.binding),
			{ type: "status", commandId: command.commandId },
			context,
		);
		if (response.type === "error") throw new StudioBrokerError(response.error.code, response.error.message);
		if (response.type !== "result") throw new StudioBrokerError("outcome_unknown", "Missing command status");
		return response.result;
	}
	async reconcile(binding: StudioBinding): Promise<void> {
		const connection = this.connection(binding);
		connection.phase = "reconciling";
		connection.fresh = false;
		this.notify();
		await this.freshContext(binding);
		connection.fresh = true;
		for (const { command } of [...this.commands.values()]) {
			if (command.binding.designId === binding.designId && command.binding.tabId === binding.tabId)
				await this.status(command);
		}
		if (this.connections.get(binding.tabId) !== connection || !connection.subscribed || this.closed) return;
		connection.phase = [...this.commands.values()].some(
			({ command }) => command.binding.designId === binding.designId,
		)
			? "reconciling"
			: "ready";
		this.notify();
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const id of this.pending.keys())
			this.finish(id, new StudioBrokerError("studio_unavailable", "Studio broker is shutting down"));
		await Promise.allSettled(this.deliveries);
		this.listeners.clear();
	}
}

export function validateStudioSnapshot(snapshot: StudioSnapshot): void {
	const vector = (value: unknown): value is [number, number, number] =>
		Array.isArray(value) &&
		value.length === 3 &&
		value.every((part) => typeof part === "number" && Number.isFinite(part));
	if (
		!snapshot ||
		typeof snapshot.designId !== "string" ||
		!snapshot.designId ||
		typeof snapshot.revision !== "string" ||
		!snapshot.revision ||
		!Array.isArray(snapshot.objects) ||
		!Array.isArray(snapshot.selectedObjectIds) ||
		!Array.isArray(snapshot.openings) ||
		!snapshot.geometry ||
		!Number.isFinite(snapshot.geometry.height) ||
		snapshot.geometry.height <= 0 ||
		!Array.isArray(snapshot.geometry.floor) ||
		snapshot.geometry.floor.length < 3 ||
		snapshot.geometry.floor.some(
			(point) => !Array.isArray(point) || point.length !== 2 || point.some((part) => !Number.isFinite(part)),
		)
	)
		throw new StudioBrokerError("invalid_arguments", "Invalid saved room snapshot");
	const ids = new Set<string>();
	for (const object of snapshot.objects) {
		if (
			!object ||
			typeof object.id !== "string" ||
			!object.id ||
			ids.has(object.id) ||
			typeof object.name !== "string" ||
			typeof object.category !== "string" ||
			!vector(object.position) ||
			!vector(object.rotation) ||
			!vector(object.scale) ||
			!vector(object.dimensions) ||
			object.scale.some((part) => part <= 0) ||
			object.dimensions.some((part) => part <= 0)
		)
			throw new StudioBrokerError("invalid_arguments", "Invalid or duplicate placed object");
		ids.add(object.id);
	}
	if (snapshot.selectedObjectIds.some((id) => !ids.has(id)))
		throw new StudioBrokerError("invalid_target", "Selection contains an unknown placed object");
	for (const opening of snapshot.openings)
		if (
			!opening ||
			typeof opening.id !== "string" ||
			!["door", "window"].includes(opening.kind) ||
			!vector(opening.position) ||
			!vector(opening.dimensions)
		)
			throw new StudioBrokerError("invalid_arguments", "Invalid room opening");
}
