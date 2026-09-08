import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Session, type SessionReader, setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import type {
	StudioBinding,
	StudioCommand,
	StudioCommandResult,
	StudioSnapshot,
	StudioTransform,
} from "./services/studio.ts";
import { STUDIO_ANGLE_TOLERANCE, STUDIO_TRANSFORM_TOLERANCE } from "./services/studio.ts";
import { type StudioBroker, validateStudioSnapshot } from "./studio-broker.ts";

export interface StudioPlanningSnapshot {
	operationId: string;
	turnId: string;
	binding: StudioBinding | null;
	snapshot: StudioSnapshot | null;
	unavailable: string | null;
}

export interface StudioCommandRecord {
	command: StudioCommand;
	operationId: string;
	turnId: string;
	invocationId: string;
	observedBefore: StudioTransform;
	state: "prepared" | "outcome_unknown" | "committed" | "rejected" | "cancelled_before_send";
	result: StudioCommandResult | null;
	createdAt: number;
}

const bindingAddress = value<StudioBinding | null>("livi.studio.binding");
const admissionAddress = (operationId: string) => value<StudioBinding | null>("livi.studio.operation", operationId);
const planningAddress = (operationId: string, turnId: string) =>
	value<StudioPlanningSnapshot>("livi.studio.planning", JSON.stringify([operationId, turnId]));
const commandAddress = (commandId: string) => value<StudioCommandRecord>("livi.studio.command", commandId);
const mutationBlockAddress = (operationId: string) => value<boolean>("livi.studio.mutation_block", operationId);

/** Inventory through the repository's existing owner; never opens a second Session writer. */
export async function readStudioJournal(reader: SessionReader, context: Context = BACKGROUND_CONTEXT) {
	const [binding, records] = await Promise.all([
		reader.getValue(bindingAddress, context),
		reader.scanValues(commandAddress(""), context),
	]);
	return { binding: binding?.value ?? null, records: records.map((entry) => entry.value) };
}

/** Called by startup inventory on its sole owned Session, before any harness drives. */
export async function restoreStudioJournal(session: Session, broker: StudioBroker): Promise<StudioJournal> {
	const journal = new StudioJournal(session);
	const inventory = await readStudioJournal(session);
	broker.claim(session.metadata.id, inventory.binding);
	for (const record of inventory.records) {
		if (record.state === "prepared") await journal.cancelPrepared(record.operationId);
		if (record.state !== "outcome_unknown") continue;
		broker.track(record.command, async (result) => {
			const settled = await journal.settle(result);
			if (settled.state === "committed" || settled.state === "rejected") broker.release(result.commandId);
		});
	}
	return journal;
}

export class StudioJournal {
	readonly session: Session;
	constructor(session: Session) {
		this.session = session;
	}

	async mutationBlocked(operationId: string): Promise<boolean> {
		return (await this.session.getValue(mutationBlockAddress(operationId), BACKGROUND_CONTEXT))?.value === true;
	}

	/** A failed reversal requires a new user request, never a model-generated coordinate fallback. */
	async blockMutations(operationId: string): Promise<void> {
		await this.session.mutate(async (writer) => {
			const records = await writer.scanValues(commandAddress(""), BACKGROUND_CONTEXT);
			await writer.commit(
				[
					setValue(mutationBlockAddress(operationId), true),
					...records
						.filter(({ value: record }) => record.operationId === operationId && record.state === "prepared")
						.map(({ address, value: record }) =>
							setValue(address, { ...record, state: "cancelled_before_send" as const }),
						),
				],
				BACKGROUND_CONTEXT,
			);
		}, BACKGROUND_CONTEXT);
	}

	async binding(context: Context = BACKGROUND_CONTEXT): Promise<StudioBinding | null> {
		return (await this.session.getValue(bindingAddress, context))?.value ?? null;
	}

	setBinding(binding: StudioBinding | null, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		return this.session.setValue(bindingAddress, binding, context);
	}

	/** The caller serializes this with binding changes and lane.accept. Null is durable evidence too. */
	async admit(operationId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.session.mutate(async (writer) => {
			const binding = await writer.getValue(bindingAddress, context);
			if (await writer.getValue(admissionAddress(operationId), context))
				throw new Error("Duplicate Studio admission");
			await writer.commit([setValue(admissionAddress(operationId), binding?.value ?? null)], context);
		}, context);
	}

	discardAdmission(operationId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		return this.session.deleteValue(admissionAddress(operationId), context);
	}

	async admission(operationId: string, context: Context = BACKGROUND_CONTEXT) {
		return this.session.getValue(admissionAddress(operationId), context);
	}

	async planning(operationId: string, turnId: string, context: Context = BACKGROUND_CONTEXT) {
		return (await this.session.getValue(planningAddress(operationId, turnId), context))?.value;
	}

	/** First planning boundary wins; execution and replay may only read this record. */
	async plan(
		snapshot: StudioPlanningSnapshot,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<StudioPlanningSnapshot> {
		return this.session.mutate(async (writer) => {
			const address = planningAddress(snapshot.operationId, snapshot.turnId);
			const existing = await writer.getValue(address, context);
			if (existing) return existing.value;
			const admission = await writer.getValue(admissionAddress(snapshot.operationId), context);
			if (snapshot.snapshot !== null && (!admission || !isDeepStrictEqual(admission.value, snapshot.binding)))
				throw new Error("Planning requires the operation's original Studio binding");
			await writer.commit([setValue(address, snapshot)], context);
			return snapshot;
		}, context);
	}

	async records(context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord[]> {
		return (await this.session.scanValues(commandAddress(""), context)).map((entry) => entry.value);
	}

	async get(commandId: string, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord | undefined> {
		return (await this.session.getValue(commandAddress(commandId), context))?.value;
	}

	async prepare(
		record: Omit<StudioCommandRecord, "state" | "result" | "createdAt">,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<StudioCommandRecord> {
		return this.session.mutate(async (writer) => {
			const address = commandAddress(record.command.commandId);
			const existing = await writer.getValue(address, context);
			if (existing) {
				if (!isDeepStrictEqual(existing.value.command, record.command))
					throw new Error("Command identity conflict");
				return existing.value;
			}
			if ((await writer.getValue(mutationBlockAddress(record.operationId), context))?.value)
				throw new Error(
					"reversal_blocked: A reversal failed in this request. Do not fall back to absolute coordinates or another mutation; explain the conflict and wait for a new user prompt",
				);
			const planning = await writer.getValue(planningAddress(record.operationId, record.turnId), context);
			const admission = await writer.getValue(admissionAddress(record.operationId), context);
			if (
				!planning?.value.snapshot ||
				!admission?.value ||
				!isDeepStrictEqual(admission.value, record.command.binding) ||
				!isDeepStrictEqual(planning.value.binding, record.command.binding) ||
				planning.value.snapshot.revision !== record.command.expectedRevision ||
				record.command.conversationId !== this.session.metadata.id ||
				record.command.commandId !== JSON.stringify([this.session.metadata.id, record.invocationId])
			)
				throw new Error("Missing or inconsistent planning evidence; replan the room action");
			const next: StudioCommandRecord = { ...record, state: "prepared", result: null, createdAt: Date.now() };
			await writer.commit([setValue(address, next)], context);
			return next;
		}, context);
	}

	/** Commit uncertainty before the broker can expose the command in its mailbox. */
	async dispatch(
		commandId: string,
		signal: AbortSignal,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<StudioCommandRecord> {
		return this.session.mutate(async (writer) => {
			const address = commandAddress(commandId);
			const stored = await writer.getValue(address, context);
			if (!stored) throw new Error("Command has not been prepared");
			if (stored.value.state !== "prepared") return stored.value;
			const next: StudioCommandRecord = {
				...stored.value,
				state: signal.aborted ? "cancelled_before_send" : "outcome_unknown",
			};
			await writer.commit([setValue(address, next)], context);
			return next;
		}, context);
	}

	async settle(result: StudioCommandResult, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord> {
		return this.session.mutate(async (writer) => {
			const address = commandAddress(result.commandId);
			const stored = await writer.getValue(address, context);
			if (!stored) throw new Error("Unknown command result");
			const record = stored.value;
			if (record.state === "committed" || record.state === "rejected") {
				if (!isDeepStrictEqual(record.result, result)) throw new Error("Conflicting authoritative command result");
				return record;
			}
			if (record.state !== "outcome_unknown") throw new Error("Result arrived for an unpublished command");
			if (result.status === "saved") {
				const planning = await writer.getValue(planningAddress(record.operationId, record.turnId), context);
				if (!planning?.value.snapshot) throw new Error("Saved result has no original planning evidence");
				validateStudioSnapshot(result.snapshot);
				const original = planning.value.snapshot;
				const { command } = record;
				if (
					result.snapshot.designId !== command.binding.designId ||
					result.revision !== result.snapshot.revision ||
					result.revision === command.expectedRevision
				)
					throw new Error("Saved result has inconsistent design or revision");
				const finite = (transform: StudioTransform | null): transform is StudioTransform =>
					transform !== null &&
					(["position", "rotation", "scale"] as const).every(
						(field) =>
							Array.isArray(transform[field]) &&
							transform[field].length === 3 &&
							transform[field].every((part) => typeof part === "number" && Number.isFinite(part)),
					);
				if (!finite(result.before) || (result.after !== null && !finite(result.after)))
					throw new Error("Saved result has invalid transforms");
				const equal = (left: StudioTransform, right: StudioTransform): boolean =>
					(["position", "rotation", "scale"] as const).every((field) =>
						left[field].every((part, index) => {
							const delta = part - right[field][index]!;
							return (
								Math.abs(field === "rotation" ? Math.atan2(Math.sin(delta), Math.cos(delta)) : delta) <=
								(field === "rotation" ? STUDIO_ANGLE_TOLERANCE : STUDIO_TRANSFORM_TOLERANCE)
							);
						}),
					);
				if (!equal(record.observedBefore, result.before))
					throw new Error("Saved before transform conflicts with planning evidence");
				const savedObject = result.snapshot.objects.find((object) => object.id === command.objectId);
				if (command.action.type === "remove") {
					if (result.after !== null || savedObject) throw new Error("Removal result still contains the object");
				} else {
					const expected = {
						...result.before,
						...(command.action.type === "move"
							? { position: command.action.position }
							: { rotation: command.action.rotation }),
					};
					if (!result.after || !savedObject || !equal(expected, result.after) || !equal(savedObject, result.after))
						throw new Error("Saved transform does not match the requested action or preserved fields");
					const plannedObject = original.objects.find((object) => object.id === command.objectId);
					if (
						!plannedObject ||
						savedObject.name !== plannedObject.name ||
						savedObject.category !== plannedObject.category ||
						!isDeepStrictEqual(savedObject.dimensions, plannedObject.dimensions)
					)
						throw new Error("Saved action changed object identity");
				}
				if (
					!isDeepStrictEqual(
						original.objects.filter((object) => object.id !== command.objectId),
						result.snapshot.objects.filter((object) => object.id !== command.objectId),
					) ||
					!isDeepStrictEqual(original.geometry, result.snapshot.geometry) ||
					!isDeepStrictEqual(original.openings, result.snapshot.openings)
				)
					throw new Error("Saved action changed unrelated room data");
			}
			const next: StudioCommandRecord = {
				...record,
				state:
					result.status === "saved" ? "committed" : result.status === "rejected" ? "rejected" : "outcome_unknown",
				result,
			};
			await writer.commit([setValue(address, next)], context);
			return next;
		}, context);
	}

	async cancelPrepared(operationId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.session.mutate(async (writer) => {
			const records = await writer.scanValues(commandAddress(""), context);
			const writes = records
				.filter(({ value: record }) => record.operationId === operationId && record.state === "prepared")
				.map(({ address, value: record }) =>
					setValue(address, { ...record, state: "cancelled_before_send" as const }),
				);
			if (writes.length) await writer.commit(writes, context);
		}, context);
	}
}
