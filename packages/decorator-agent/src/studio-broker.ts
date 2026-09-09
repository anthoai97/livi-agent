import { randomUUID } from "node:crypto";
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
	mailbox: ReturnType<typeof replicatedState<StudioMailboxState>>;
}
interface Pending {
	connection: Connection;
	request: StudioMailboxRequest;
	resolve(response: StudioResponse): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** Routes each request once to the currently connected Studio. */
export class StudioBroker {
	readonly directory = replicatedState<{
		studios: { designId: string; tabId: string; label: string; phase: StudioPhase }[];
	}>({ studios: [] });
	private readonly connections = new Map<string, Connection>();
	private readonly pending = new Map<string, Pending>();
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
	getState(binding: StudioBinding | null): { phase: StudioPhase; snapshot: StudioSnapshot | null } {
		const connection = binding ? this.connections.get(binding.tabId) : undefined;
		return {
			phase: connection?.binding.designId === binding?.designId ? (connection?.phase ?? "offline") : "offline",
			snapshot:
				connection?.binding.designId === binding?.designId ? structuredClone(connection?.snapshot ?? null) : null,
		};
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
					if (previous) throw new StudioBrokerError("wrong_binding", "This tab already has an active connection");
					connection = {
						binding: { designId: registration.designId, tabId: registration.tabId },
						label: registration.label,
						generation: randomUUID(),
						sequence: -1,
						phase: "offline",
						snapshot: null,
						subscribed: false,
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
					current.phase = "ready";
					this.notify();
				},
				publishContext: async (update) => {
					this.applyContext(authorize(update.generation), update);
				},
				publishSelection: async (update) => {
					const current = authorize(update.generation);
					if (!Number.isSafeInteger(update.sequence) || update.sequence < 0)
						throw new StudioBrokerError("invalid_arguments", "Invalid selection sequence");
					if (update.sequence <= current.sequence || !current.snapshot) return;
					if (
						!Array.isArray(update.selectedObjectIds) ||
						update.selectedObjectIds.some((id) => typeof id !== "string" || !id)
					)
						throw new StudioBrokerError("invalid_target", "Selection must contain object IDs");
					current.sequence = update.sequence;
					current.snapshot.selectedObjectIds = [...update.selectedObjectIds];
					this.notify();
				},
				respond: async (response) => {
					const current = authorize(response.generation);
					const pending = this.pending.get(response.requestId);
					if (!pending) return; // Late replies do not reopen a completed wait.
					if (pending.connection !== current)
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
				this.connections.delete(connection.binding.tabId);
				connection.phase = "offline";
				connection.subscribed = false;
				connection.snapshot = null;
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
			if (pending.request.type !== "execute" || pending.request.command.commandId !== response.result.commandId)
				throw new StudioBrokerError("wrong_binding", "Result command does not match the request");
			if (response.result.status === "saved" && response.result.snapshot.designId !== connection.binding.designId)
				throw new StudioBrokerError("wrong_binding", "Saved result belongs to another design");
			if (response.context) this.applyContext(connection, response.context);
		} else if (response.type !== "error") throw new StudioBrokerError("invalid_arguments", "Invalid response");
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
		payload: { type: "context" } | { type: "execute"; command: StudioCommand },
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
				this.finish(request.requestId, error);
			}, this.timeoutMs);
			this.pending.set(request.requestId, { connection, request, resolve, reject, timer });
			connection.mailbox.state.requests = [...connection.mailbox.state.requests, request];
			connection.mailbox.publish(BACKGROUND_CONTEXT);
		});
		return awaitWithContext(promise, context).finally(() => {
			this.finish(request.requestId, new StudioBrokerError("outcome_unknown", "Stopped waiting for Studio"));
		});
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
		const response = await this.request(connection, { type: "execute", command: structuredClone(command) }, context);
		if (response.type === "error") return { commandId: command.commandId, status: "rejected", error: response.error };
		if (response.type !== "result") throw new StudioBrokerError("outcome_unknown", "Missing mutation outcome");
		return response.result;
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
	if (
		!snapshot ||
		typeof snapshot.designId !== "string" ||
		!snapshot.designId ||
		typeof snapshot.revision !== "string" ||
		!snapshot.revision ||
		!Array.isArray(snapshot.objects) ||
		!Array.isArray(snapshot.selectedObjectIds)
	)
		throw new StudioBrokerError("invalid_arguments", "Invalid Studio context");
}
