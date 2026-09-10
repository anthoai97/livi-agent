import type { MutableReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentLane,
	type HarnessEvent,
	type LaneSnapshot,
	type LaneTranscriptSnapshot,
	type LaneWatchEvent,
	reduceLaneSnapshot,
	type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { Transcript as TranscriptService, TranscriptState } from "./transcript.ts";

interface TranscriptRuntime {
	readonly service: TranscriptService;
	activate(): Promise<void>;
	dispose(): Promise<void>;
}

export function createTranscriptService(
	lane: AgentLane,
	createState: (initial: TranscriptState) => MutableReplicatedState<TranscriptState>,
): TranscriptRuntime {
	const state = createState({ snapshot: null, event: null });
	let watch: WatchHandle<LaneSnapshot> | undefined;
	let rebase: Promise<void> | undefined;
	let rebaseError: Error | undefined;

	const publishSnapshot = async (
		next: LaneSnapshot,
		event: LaneWatchEvent | null,
		context: Parameters<typeof state.publish>[0],
	): Promise<void> => {
		// The model snapshot starts at the latest compaction; the UI retains the full branch.
		const transcript =
			next.tipId === null ? [] : await lane.findEntries({ start: next.tipId, order: "oldestFirst" }, context);
		// Provider messages may contain explicitly undefined optional fields.
		// Copy into JSON form before Chord records replicated state operations.
		state.state.snapshot = JSON.parse(JSON.stringify({ ...next, transcript })) as LaneTranscriptSnapshot;
		state.state.event = event;
		state.publish(context);
	};

	const onEvent = async (event: HarnessEvent, context: Parameters<typeof state.publish>[0]): Promise<void> => {
		if (rebaseError !== undefined) throw rebaseError;
		const projected = toLaneWatchEvent(event);
		if (projected === undefined) return;
		const forwarded = JSON.parse(JSON.stringify(projected)) as LaneWatchEvent;
		const snapshot = state.state.snapshot;
		if (snapshot === null) throw new Error("Transcript service is not active");
		if (
			forwarded.type === "entry_added" &&
			forwarded.lane === snapshot.lane &&
			forwarded.entry.type === "compaction"
		) {
			// Compaction changes model context, not the visible conversation or its recommendation cards.
			snapshot.transcript.push(forwarded.entry);
			snapshot.tipId = forwarded.entry.id;
		} else if (reduceLaneSnapshot(snapshot, forwarded) === "rebase") {
			const activeWatch = watch;
			if (activeWatch === undefined) return;
			rebase = (async () => {
				await publishSnapshot(await activeWatch.resnapshot(context), forwarded, context);
			})();
			try {
				// The harness awaits listeners, so subsequent events apply to the refreshed snapshot.
				await rebase;
			} catch (error) {
				rebaseError = error instanceof Error ? error : new Error(String(error));
				throw rebaseError;
			} finally {
				rebase = undefined;
			}
			return;
		}
		state.state.event = forwarded;
		state.publish(context);
	};

	return {
		service: { state },
		async activate() {
			if (watch !== undefined) throw new Error("Transcript service is already active");
			const opened = await lane.watch(BACKGROUND_CONTEXT);
			watch = opened;
			try {
				await publishSnapshot(opened.snapshot, null, BACKGROUND_CONTEXT);
				opened.start(onEvent);
			} catch (error) {
				opened.unsubscribe();
				watch = undefined;
				throw error;
			}
		},
		async dispose() {
			let failure: unknown;
			try {
				await rebase;
			} catch (error) {
				failure = error;
			}
			watch?.unsubscribe();
			watch = undefined;
			if (failure !== undefined) throw failure;
		},
	};
}

function toLaneWatchEvent(event: HarnessEvent): LaneWatchEvent | undefined {
	switch (event.type) {
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return undefined;
		case "config_update":
			if (event.property !== "model" && event.property !== "thinkingLevel" && event.property !== "activeTools") {
				return undefined;
			}
			return event as LaneWatchEvent;
		case "message_update": {
			if (event.message.role !== "assistant") {
				throw new TypeError("Harness message_update did not carry an assistant message");
			}
			const { event: _providerEvent, ...update } = event;
			return update as LaneWatchEvent;
		}
		default:
			return event as LaneWatchEvent;
	}
}
