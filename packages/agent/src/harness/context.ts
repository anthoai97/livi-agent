import type { Context, ContextKey } from "@earendil-works/chord";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
} from "@earendil-works/chord/context";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";

export {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	type ContextKey,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
};

const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("pi.telemetryContext");

/** Stable turn identity supplied to systemPrompt, toolContext, and tool execution callbacks. */
export interface AgentHarnessTurnContext {
	readonly lane: string;
	readonly operationId: string;
	readonly turnId: string;
	/** Tools share the identity of the assistant generation that planned their arguments. */
	readonly phase: "assistant" | "tools";
}

const TURN_CONTEXT_KEY = createContextKey<AgentHarnessTurnContext>("pi.harness.turn");

export function getAgentHarnessTurnContext(context: Context): AgentHarnessTurnContext | undefined {
	return context.value(TURN_CONTEXT_KEY);
}

/** Derive callback context without changing the caller's context or cancellation signal. */
export function withAgentHarnessTurnContext(turn: AgentHarnessTurnContext, context: Context): Context {
	return withContextValue(TURN_CONTEXT_KEY, Object.freeze({ ...turn }), context);
}

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
	return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}
