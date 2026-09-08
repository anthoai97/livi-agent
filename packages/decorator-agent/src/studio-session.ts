import { type Context, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { laneState, operationState, type Session } from "@earendil-works/pi-agent-core/harness/session";
import type { StudioCommand, StudioSession, StudioSessionState } from "./services/studio.ts";
import type { StudioBroker } from "./studio-broker.ts";
import {
	restoreStudioJournal,
	type StudioCommandRecord,
	StudioJournal,
	type StudioPlanningSnapshot,
} from "./studio-journal.ts";

export class StudioSessionRuntime {
	readonly journal: StudioJournal;
	readonly service: StudioSession;
	private readonly state = replicatedState<StudioSessionState>({
		binding: null,
		phase: "offline",
		snapshot: null,
		busy: false,
		actions: [],
	});
	private serial: Promise<unknown> = Promise.resolve();
	private readonly shutdown = new AbortController();
	private unsubscribe?: () => void;
	private publishing: Promise<void> = Promise.resolve();
	readonly session: Session;
	readonly broker: StudioBroker | undefined;

	constructor(session: Session, broker?: StudioBroker) {
		this.session = session;
		this.broker = broker;
		this.journal = new StudioJournal(session);
		this.service = {
			state: this.state,
			bind: (binding, context) =>
				this.exclusive(async () => {
					if (this.shutdown.signal.aborted) throw new Error("Studio session is closed");
					const records = await this.journal.records(context);
					if (records.some((record) => record.state === "prepared" || record.state === "outcome_unknown"))
						throw new Error("Wait for the previous room action to resolve before changing rooms");
					if (!this.broker && binding) throw new Error("Studio is unavailable");
					const previous = await this.journal.binding(context);
					this.broker?.claim(this.session.metadata.id, binding);
					try {
						await this.journal.setBinding(binding, context);
					} catch (error) {
						this.broker?.claim(this.session.metadata.id, previous);
						throw error;
					}
					await this.publish();
				}),
		};
	}

	exclusive<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.serial.then(action);
		this.serial = pending.catch(() => {});
		return pending;
	}

	async activate(): Promise<void> {
		if (this.broker) {
			await restoreStudioJournal(this.session, this.broker);
			for (const record of await this.journal.records())
				if (record.state === "outcome_unknown") this.track(record.command);
			this.unsubscribe = this.broker.subscribe(() => {
				void this.publish();
			});
		}
		await this.publish();
	}

	private track(command: StudioCommand): void {
		this.broker?.track(command, async (result) => {
			const record = await this.journal.settle(result);
			if (record.state === "committed" || record.state === "rejected") this.broker?.release(command.commandId);
			await this.publish();
		});
	}

	publish(): Promise<void> {
		const pending = this.publishing.then(async () => {
			if (this.shutdown.signal.aborted) return;
			const binding = await this.journal.binding();
			const records = await this.journal.records();
			const current = this.broker?.getState(binding) ?? { phase: "offline" as const, snapshot: null, busy: false };
			this.state.state.binding = binding;
			this.state.state.phase = current.phase;
			this.state.state.snapshot = current.snapshot;
			this.state.state.busy =
				current.busy || records.some((record) => record.state === "prepared" || record.state === "outcome_unknown");
			this.state.state.actions = records.map((record) => ({
				commandId: record.command.commandId,
				objectId: record.command.objectId,
				action: record.command.action.type,
				state: record.state,
				message:
					record.state === "committed"
						? "Saved"
						: record.state === "rejected" && record.result?.status === "rejected"
							? record.result.error.message
							: record.state === "cancelled_before_send"
								? "Cancelled before sending"
								: record.state === "prepared"
									? "Preparing room action"
									: "Checking whether the room action was saved; Stop does not undo it",
			}));
			this.state.publish(BACKGROUND_CONTEXT);
		});
		this.publishing = pending.catch(() => {});
		return pending;
	}

	/** Resolves twice per turn in the harness; only assistant.ready may create fresh evidence. */
	async context(): Promise<StudioPlanningSnapshot | undefined> {
		const identity = await this.session.mutate(async (reader) => {
			const lane = await reader.getValue(laneState("main"), BACKGROUND_CONTEXT);
			const operationId = lane?.value.currentOperationId;
			if (!operationId) return undefined;
			const operation = await reader.getValue(operationState(operationId), BACKGROUND_CONTEXT);
			const state = operation?.value;
			if (state?.at === "assistant.ready")
				return { operationId, turnId: state.generationContext.stepId, planning: true };
			if (state?.at === "tools") return { operationId, turnId: state.batch.turnId, planning: false };
			return undefined;
		}, BACKGROUND_CONTEXT);
		if (!identity) return undefined;
		const existing = await this.journal.planning(identity.operationId, identity.turnId);
		if (existing || !identity.planning) return existing;
		const admission = await this.journal.admission(identity.operationId);
		const binding = admission?.value ?? null;
		let snapshot: StudioPlanningSnapshot["snapshot"] = null;
		let unavailable: string | null = admission
			? "Attach a connected Studio to use room actions"
			: "This operation has no recorded room binding; submit a new request";
		if (binding && this.broker) {
			try {
				snapshot = await this.broker.freshContext(
					binding,
					withAbortSignal(this.shutdown.signal, BACKGROUND_CONTEXT),
				);
				unavailable = null;
			} catch (error) {
				unavailable = error instanceof Error ? error.message : String(error);
			}
		}
		return this.journal.plan({
			operationId: identity.operationId,
			turnId: identity.turnId,
			binding,
			snapshot,
			unavailable,
		});
	}

	async execute(record: StudioCommandRecord, context: Context): Promise<StudioCommandRecord> {
		if (record.state === "committed" || record.state === "rejected" || record.state === "cancelled_before_send")
			return record;
		if (!this.broker) throw new Error("Studio is unavailable");
		const active = withAbortSignal(this.shutdown.signal, context);
		try {
			this.track(record.command);
		} catch (error) {
			if (record.state === "prepared") await this.journal.cancelPrepared(record.operationId);
			throw error;
		}
		if (record.state === "outcome_unknown") {
			await this.broker.status(record.command, active);
		} else {
			record = await this.journal.dispatch(record.command.commandId, active.abortSignal!);
			await this.publish();
			if (record.state === "cancelled_before_send") this.broker.release(record.command.commandId);
			else await this.broker.execute(record.command, active);
		}
		return (await this.journal.get(record.command.commandId))!;
	}

	prepare(record: Parameters<StudioJournal["prepare"]>[0]): Promise<StudioCommandRecord> {
		return this.exclusive(async () => {
			if (this.shutdown.signal.aborted) throw new Error("Studio session is closed");
			const binding = await this.journal.binding();
			if (binding?.designId !== record.command.binding.designId || binding?.tabId !== record.command.binding.tabId)
				throw new Error("wrong_binding: The conversation changed rooms after this request; submit a new request");
			const state = this.broker?.getState(binding);
			if (state?.busy)
				throw new Error(
					"design_busy: A previous command outcome is unresolved; context reads and ordinary chat remain available",
				);
			if (state?.phase !== "ready")
				throw new Error(
					"studio_unavailable: Connect Studio and finish reconciliation before requesting a room action",
				);
			return this.journal.prepare(record);
		});
	}

	async close(): Promise<void> {
		this.shutdown.abort(new Error("Studio session is closing; published command outcomes remain pending"));
		this.unsubscribe?.();
		await this.serial;
		await this.publishing;
	}
}
