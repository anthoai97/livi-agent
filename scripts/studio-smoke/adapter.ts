import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as context } from "../../packages/chord/dist/context/index.js";
import { createRemoteServiceBinding } from "../../packages/chord/dist/index.js";
import { createClientServiceTransport } from "../../packages/client/dist/index.js";
import {
	STUDIO_CONTRACT_VERSION,
	STUDIO_QUANTITY_MAX,
	type StudioCommand,
	type StudioCommandEdit,
	type StudioCommandResult,
	StudioConnection,
	type StudioContextUpdate,
	type StudioCreatedInstance,
	type StudioEditResult,
	type StudioMailboxRequest,
	type StudioPlacement,
	type StudioSnapshot,
	type StudioTransform,
	type StudioVector3,
} from "../../packages/decorator-agent/dist/contracts.js";
import { connectClient } from "./connection.js";
import { type JsonCatalogFact, validateSnapshot } from "./room.js";

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
	failNextSave = false;
	beforeExecute?: (command: StudioCommand) => Promise<void>;
	private catalog = new Map<string, JsonCatalogFact>();

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

	async load(initial: StudioSnapshot, catalog: JsonCatalogFact[] = []) {
		this.catalog = new Map(catalog.map((product) => [product.catalogId, product]));
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
					contractVersion: STUDIO_CONTRACT_VERSION,
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
		else {
			try {
				const failSave = this.failNextSave;
				this.failNextSave = false;
				if (failSave) throw Object.assign(new Error("Simulated save failure"), { code: "save_rejected" });
				const edits: StudioCommandEdit[] =
					command.action.type === "batch" ? command.action.edits : [command as StudioCommandEdit];
				const count = edits.reduce(
					(sum, edit) =>
						sum + (edit.action.type === "add" || edit.action.type === "duplicate" ? edit.action.quantity : 1),
					0,
				);
				if (count < 1 || count > STUDIO_QUANTITY_MAX) throw new Error("Batch requires 1-50 expanded operations");
				const results: StudioEditResult[] = [];
				for (const edit of edits) {
					if (edit.action.type === "add" || edit.action.type === "duplicate") {
						results.push({ kind: "create", created: this.applyCreate(next.snapshot, edit) });
					} else {
						const target = next.snapshot.objects.find((entry) => entry.id === edit.objectId);
						if (!target) throw new Error("Placed object does not exist");
						const before: StudioTransform = structuredClone({
							position: target.position,
							rotation: target.rotation,
							scale: target.scale,
						});
						switch (edit.action.type) {
							case "move":
								target.position = structuredClone(edit.action.position);
								break;
							case "rotate":
								target.rotation = structuredClone(edit.action.rotation);
								break;
							case "replace":
								if ((target.product?.catalogId ?? null) !== edit.action.expectedCatalogId)
									throw new Error("Prior catalog product changed");
								target.product = { catalogId: edit.action.catalogId, price: null };
								break;
							case "remove":
								next.snapshot.objects = next.snapshot.objects.filter((entry) => entry.id !== edit.objectId);
								next.snapshot.selectedObjectIds = next.snapshot.selectedObjectIds.filter(
									(id) => id !== edit.objectId,
								);
								break;
						}
						results.push({
							kind: "edit",
							before,
							after:
								edit.action.type === "remove"
									? null
									: structuredClone({
											position: target.position,
											rotation: target.rotation,
											scale: target.scale,
										}),
						});
					}
					validateSnapshot(next.snapshot);
				}
				next.saveCount += 1;
				next.snapshot.revision = /^(0|[1-9][0-9]*)$/.test(next.snapshot.revision)
					? String(Number(next.snapshot.revision) + count)
					: `simulated:${next.saveCount}:${randomUUID()}`;
				result = {
					commandId: command.commandId,
					status: "saved",
					revision: next.snapshot.revision,
					snapshot: structuredClone(next.snapshot),
					...(command.action.type === "batch" ? { kind: "batch", results } : results[0]!),
				};
			} catch (error) {
				next.snapshot = this.snapshot;
				next.saveCount = this.state.saveCount;
				result = {
					commandId: command.commandId,
					status: "rejected",
					error: {
						code:
							error instanceof Error && "code" in error && error.code === "save_rejected"
								? "save_rejected"
								: error instanceof Error && /does not exist|anchor/i.test(error.message)
									? "invalid_target"
									: "invalid_arguments",
						message: error instanceof Error ? error.message : String(error),
					},
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

	private applyCreate(snapshot: StudioSnapshot, command: StudioCommandEdit): StudioCreatedInstance[] {
		const action = command.action;
		if (action.type !== "add" && action.type !== "duplicate") throw new Error("Unsupported Studio action");
		if (!Number.isSafeInteger(action.quantity) || action.quantity < 1 || action.quantity > STUDIO_QUANTITY_MAX)
			throw new Error("quantity must be a positive integer at most 50");
		if (action.type === "duplicate") {
			const source = snapshot.objects.find((entry) => entry.id === action.sourceObjectId);
			if (!source) throw new Error("Duplicate source does not exist");
			const origin = resolveOrigin(
				snapshot,
				action.placement,
				addVectors(source.position, copyOffset(source.dimensions)),
			);
			const step = copyOffset(source.dimensions);
			const created: StudioCreatedInstance[] = [];
			for (let index = 0; index < action.quantity; index++) {
				const transform: StudioTransform = {
					position: addVectors(origin, step, index),
					rotation: structuredClone(source.rotation),
					scale: structuredClone(source.scale),
				};
				const object = { ...structuredClone(source), id: randomUUID(), ...transform };
				snapshot.objects.push(object);
				created.push({ objectId: object.id, transform });
			}
			return created;
		}
		const fact = this.catalog.get(action.catalogId);
		if (!fact) throw new Error("Unknown catalog product");
		const origin = resolveOrigin(snapshot, action.placement, roomCenter(snapshot));
		const rotation =
			action.placement?.type === "absolute" && action.placement.rotation
				? structuredClone(action.placement.rotation)
				: ([0, 0, 0] as StudioVector3);
		const step = copyOffset(fact.dimensions);
		const created: StudioCreatedInstance[] = [];
		for (let index = 0; index < action.quantity; index++) {
			const transform: StudioTransform = {
				position: addVectors(origin, step, index),
				rotation: structuredClone(rotation),
				scale: [1, 1, 1],
			};
			snapshot.objects.push({
				id: randomUUID(),
				name: fact.name,
				category: fact.category,
				dimensions: structuredClone(fact.dimensions),
				...transform,
				product: { catalogId: fact.catalogId, price: fact.price },
			});
			created.push({ objectId: snapshot.objects.at(-1)!.id, transform });
		}
		return created;
	}
}

function copyOffset(dimensions: StudioVector3): StudioVector3 {
	return [Math.max(dimensions[0] * 0.35, 0.25), -Math.max(dimensions[1] * 0.35, 0.25), 0];
}

function addVectors(origin: StudioVector3, offset: StudioVector3, scale = 1): StudioVector3 {
	return [origin[0] + offset[0] * scale, origin[1] + offset[1] * scale, origin[2] + offset[2] * scale];
}

function roomCenter(snapshot: StudioSnapshot): StudioVector3 {
	const xs = snapshot.geometry.floor.map((point) => point[0]);
	const ys = snapshot.geometry.floor.map((point) => point[1]);
	return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
}

function resolveOrigin(
	snapshot: StudioSnapshot,
	placement: StudioPlacement | undefined,
	fallback: StudioVector3,
): StudioVector3 {
	if (!placement) return fallback;
	if (placement.type === "absolute") return structuredClone(placement.position);
	const anchor = snapshot.objects.find((entry) => entry.id === placement.anchorObjectId);
	if (!anchor) throw new Error("Relative placement anchor does not exist");
	return addVectors(anchor.position, placement.offset ?? copyOffset(anchor.dimensions));
}
