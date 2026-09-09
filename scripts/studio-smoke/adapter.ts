import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as context } from "../../packages/chord/dist/context/index.js";
import { createRemoteServiceBinding } from "../../packages/chord/dist/index.js";
import { createClientServiceTransport } from "../../packages/client/dist/index.js";
import {
	type StudioCommand,
	type StudioCommandResult,
	StudioConnection,
	type StudioContextUpdate,
	type StudioMailboxRequest,
	type StudioSnapshot,
	type StudioTransform,
} from "../../packages/decorator-agent/dist/contracts.js";
import { connectClient } from "./connection.js";
import { validateSnapshot } from "./room.js";

interface SavedState {
	format: 1;
	snapshot: StudioSnapshot;
	commands: Record<string, { command: StudioCommand; result: StudioCommandResult }>;
	saveCount: number;
}

/** One atomic document stores simulated room saves and their immutable deduplication evidence. */
export class JsonStudioAdapter {
	private state!: SavedState;
	private generation = "";
	private sequence = 0;
	private service?: StudioConnection;
	private closeConnection?: () => Promise<void>;
	private tail = Promise.resolve();
	private seen = new Set<string>();
	readonly emitted: StudioCommand[] = [];
	readonly requests: StudioMailboxRequest["type"][] = [];
	readonly errors: string[] = [];
	dropNextReply = false;
	beforeExecute?: (command: StudioCommand) => Promise<void>;

	constructor(
		readonly statePath: string,
		readonly tabId: string,
	) {}
	get snapshot() {
		return structuredClone(this.state.snapshot);
	}
	get saveCount() {
		return this.state.saveCount;
	}
	get results() {
		return structuredClone(this.state.commands);
	}

	async load(initial: StudioSnapshot) {
		try {
			const saved = JSON.parse(await readFile(this.statePath, "utf8")) as SavedState;
			if (
				saved.format !== 1 ||
				saved.snapshot.designId !== initial.designId ||
				!Number.isSafeInteger(saved.saveCount) ||
				typeof saved.commands !== "object" ||
				saved.commands === null
			)
				throw new Error("Invalid simulated adapter state");
			validateSnapshot(saved.snapshot);
			this.state = saved;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			this.state = { format: 1, snapshot: structuredClone(initial), commands: {}, saveCount: 0 };
			await this.persist(this.state);
		}
	}

	private async persist(next: SavedState) {
		const temporary = `${this.statePath}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(next)}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.statePath);
			const directory = await open(dirname(this.statePath), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			this.state = next;
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private update(): StudioContextUpdate {
		return { generation: this.generation, sequence: ++this.sequence, snapshot: this.snapshot };
	}

	async connect(server: { serverId: string; port: number }) {
		const client = await connectClient(server);
		const binding = createRemoteServiceBinding({
			services: [StudioConnection],
			transport: createClientServiceTransport(client, () => ({ serverId: client.serverId })),
		});
		this.closeConnection = async () => {
			await client.dispose();
			await binding.dispose(context).catch(() => {});
		};
		const service = binding.use(StudioConnection);
		await binding.ready(context);
		this.service = service;
		this.generation = (
			await service.register(
				{
					designId: this.state.snapshot.designId,
					tabId: this.tabId,
					label: `JSON Studio · ${this.state.snapshot.designId}`,
					contractVersion: 2,
				},
				context,
			)
		).generation;
		this.sequence = 0;
		this.seen.clear();
		const unsubscribe = service.mailbox.subscribe(({ requests }) => {
			for (const request of requests) {
				if (this.seen.has(request.requestId)) continue;
				this.seen.add(request.requestId);
				this.tail = this.tail
					.then(() => this.respond(request))
					.catch((error: unknown) => {
						this.errors.push(error instanceof Error ? error.message : String(error));
					});
			}
		});
		this.closeConnection = async () => {
			unsubscribe();
			await client.dispose();
			await binding.dispose(context).catch(() => {});
		};
		await service.ready(this.generation, context);
	}

	async disconnect() {
		await this.closeConnection?.();
		this.closeConnection = undefined;
		this.service = undefined;
		await this.tail;
	}

	async select(ids: string[]) {
		const snapshot = this.snapshot;
		snapshot.selectedObjectIds = [...ids];
		validateSnapshot(snapshot);
		this.state.snapshot.selectedObjectIds = [...ids];
		await this.service?.publishSelection(
			{ generation: this.generation, sequence: ++this.sequence, selectedObjectIds: ids },
			context,
		);
	}

	async manualEdit(objectId: string, transform: Partial<StudioTransform>) {
		const next = structuredClone(this.state);
		const object = next.snapshot.objects.find((entry) => entry.id === objectId);
		if (!object) throw new Error(`Missing manual-edit object ${objectId}`);
		Object.assign(object, transform);
		next.snapshot.revision = `simulated-manual:${randomUUID()}`;
		validateSnapshot(next.snapshot);
		await this.persist(next);
		await this.service?.publishContext(this.update(), context);
	}

	private async execute(command: StudioCommand): Promise<StudioCommandResult> {
		const previous = Object.hasOwn(this.state.commands, command.commandId)
			? this.state.commands[command.commandId]
			: undefined;
		if (previous) {
			if (!isDeepStrictEqual(previous.command, command))
				throw new Error("Immutable command ID reused with another payload");
			return structuredClone(previous.result);
		}
		const next = structuredClone(this.state);
		const object = next.snapshot.objects.find((entry) => entry.id === command.objectId);
		let result: StudioCommandResult;
		if (command.binding.designId !== next.snapshot.designId || command.binding.tabId !== this.tabId)
			result = {
				commandId: command.commandId,
				status: "rejected",
				error: { code: "wrong_binding", message: "Command targets another Studio" },
			};
		else if (command.expectedRevision !== next.snapshot.revision)
			result = {
				commandId: command.commandId,
				status: "rejected",
				error: { code: "stale_revision", message: "Saved JSON revision changed" },
			};
		else if (!object)
			result = {
				commandId: command.commandId,
				status: "rejected",
				error: { code: "invalid_target", message: "Placed object does not exist" },
			};
		else {
			const before = {
				position: [...object.position],
				rotation: [...object.rotation],
				scale: [...object.scale],
			} as StudioTransform;
			try {
				switch (command.action.type) {
					case "move":
						object.position = structuredClone(command.action.position);
						break;
					case "rotate":
						object.rotation = structuredClone(command.action.rotation);
						break;
					case "remove":
						next.snapshot.objects = next.snapshot.objects.filter((entry) => entry.id !== command.objectId);
						next.snapshot.selectedObjectIds = next.snapshot.selectedObjectIds.filter(
							(id) => id !== command.objectId,
						);
						break;
					default:
						throw new Error("Only move, rotate and remove are supported");
				}
				validateSnapshot(next.snapshot);
				next.saveCount += 1;
				next.snapshot.revision = `simulated:${next.saveCount}:${randomUUID()}`;
				result = {
					commandId: command.commandId,
					status: "saved",
					revision: next.snapshot.revision,
					snapshot: structuredClone(next.snapshot),
					before,
					after:
						command.action.type === "remove"
							? null
							: { position: [...object.position], rotation: [...object.rotation], scale: [...object.scale] },
				};
			} catch (error) {
				next.snapshot = this.snapshot;
				next.saveCount = this.state.saveCount;
				result = {
					commandId: command.commandId,
					status: "rejected",
					error: { code: "invalid_arguments", message: error instanceof Error ? error.message : String(error) },
				};
			}
		}
		next.commands[command.commandId] = { command: structuredClone(command), result };
		await this.persist(next);
		return result;
	}

	private async respond(request: StudioMailboxRequest) {
		const service = this.service;
		if (!service || request.generation !== this.generation) return;
		if (request.binding.designId !== this.state.snapshot.designId || request.binding.tabId !== this.tabId)
			throw new Error("Private mailbox leaked another Studio binding");
		this.requests.push(request.type);
		const identity = { requestId: request.requestId, generation: this.generation };
		if (request.type === "context") {
			await service.respond({ ...identity, type: "context", context: this.update() }, context);
			return;
		}
		this.emitted.push(structuredClone(request.command));
		await this.beforeExecute?.(request.command);
		const result = await this.execute(request.command);
		if (this.dropNextReply) {
			this.dropNextReply = false;
			return;
		}
		await service.respond({ ...identity, type: "result", result, context: this.update() }, context);
	}
}
