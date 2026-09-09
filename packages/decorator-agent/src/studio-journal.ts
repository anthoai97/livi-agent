import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Session, value } from "@earendil-works/pi-agent-core/harness/session";
import type {
	StudioBinding,
	StudioCommand,
	StudioCommandResult,
	StudioSnapshot,
	StudioTransform,
} from "./services/studio.ts";

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
const commandAddress = (commandId: string) => value<StudioCommandRecord>("livi.studio.command", commandId);

/** Current-request context is transient; completed results persist only for conversational undo. */
export class StudioJournal {
	readonly session: Session;
	private readonly admissions = new Map<string, { value: StudioBinding | null }>();
	private readonly plans = new Map<string, StudioPlanningSnapshot>();
	private readonly current = new Map<string, StudioCommandRecord>();
	private readonly blocked = new Set<string>();
	constructor(session: Session) {
		this.session = session;
	}

	async mutationBlocked(operationId: string): Promise<boolean> {
		return this.blocked.has(operationId);
	}

	async blockMutations(operationId: string): Promise<void> {
		this.blocked.add(operationId);
	}

	async binding(context: Context = BACKGROUND_CONTEXT): Promise<StudioBinding | null> {
		return (await this.session.getValue(bindingAddress, context))?.value ?? null;
	}

	setBinding(binding: StudioBinding | null, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		return this.session.setValue(bindingAddress, binding, context);
	}

	async admit(operationId: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		this.admissions.set(operationId, { value: await this.binding(context) });
	}

	async discardAdmission(operationId: string): Promise<void> {
		this.admissions.delete(operationId);
		this.blocked.delete(operationId);
		for (const [key, plan] of this.plans) if (plan.operationId === operationId) this.plans.delete(key);
		for (const [id, record] of this.current) if (record.operationId === operationId) this.current.delete(id);
	}

	async admission(operationId: string) {
		return this.admissions.get(operationId);
	}

	async planning(operationId: string, turnId: string) {
		return this.plans.get(JSON.stringify([operationId, turnId]));
	}

	async plan(snapshot: StudioPlanningSnapshot): Promise<StudioPlanningSnapshot> {
		const key = JSON.stringify([snapshot.operationId, snapshot.turnId]);
		const existing = this.plans.get(key);
		if (existing) return existing;
		this.plans.set(key, snapshot);
		return snapshot;
	}

	async records(context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord[]> {
		const records = new Map(
			(await this.session.scanValues(commandAddress(""), context)).map((entry) => [
				entry.value.command.commandId,
				entry.value,
			]),
		);
		for (const [id, record] of this.current) records.set(id, record);
		return [...records.values()];
	}

	async get(commandId: string, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord | undefined> {
		return this.current.get(commandId) ?? (await this.session.getValue(commandAddress(commandId), context))?.value;
	}

	async prepare(record: Omit<StudioCommandRecord, "state" | "result" | "createdAt">): Promise<StudioCommandRecord> {
		if (this.blocked.has(record.operationId))
			throw new Error("mutation_blocked: Wait for a new user request before another room action");
		const existing = await this.get(record.command.commandId);
		if (existing) return existing;
		const next: StudioCommandRecord = { ...record, state: "prepared", result: null, createdAt: Date.now() };
		this.current.set(record.command.commandId, next);
		return next;
	}

	async dispatch(commandId: string, signal: AbortSignal): Promise<StudioCommandRecord> {
		const record = this.current.get(commandId);
		if (!record) throw new Error("Command is not part of the current runtime");
		if (record.state !== "prepared") return record;
		const next: StudioCommandRecord = {
			...record,
			state: signal.aborted ? "cancelled_before_send" : "outcome_unknown",
		};
		this.current.set(commandId, next);
		return next;
	}

	async settle(result: StudioCommandResult, context: Context = BACKGROUND_CONTEXT): Promise<StudioCommandRecord> {
		const record = this.current.get(result.commandId);
		if (!record) throw new Error("Unknown command result");
		if (record.result) return record;
		const next: StudioCommandRecord = {
			...record,
			state: result.status === "saved" ? "committed" : result.status === "rejected" ? "rejected" : "outcome_unknown",
			result,
		};
		this.current.set(result.commandId, next);
		if (result.status === "saved") {
			try {
				await this.session.setValue(commandAddress(result.commandId), next, context);
			} catch {
				// Undo history is optional; Studio's supplied saved result remains authoritative.
			}
		}
		return next;
	}

	async cancelPrepared(operationId: string): Promise<void> {
		for (const [id, record] of this.current)
			if (record.operationId === operationId && record.state === "prepared")
				this.current.set(id, { ...record, state: "cancelled_before_send" });
	}
}
