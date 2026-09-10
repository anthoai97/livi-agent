import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

/** Manifest coordinates: metres, +X right, +Y toward back, +Z up; floor front-left origin.
 * Rotation is radians, intrinsic XYZ; Studio supports yaw only ([0, 0, yaw]).
 * Adapter rendering must retain its asset front-view correction. See docs/Studio-Contract.md.
 */
export const STUDIO_CONTRACT_VERSION = 2;
export const STUDIO_TRANSFORM_TOLERANCE = 0.0001;
export const STUDIO_ANGLE_TOLERANCE = 0.000001;
export type StudioVector3 = [number, number, number];
export interface StudioTransform {
	position: StudioVector3;
	rotation: StudioVector3;
	scale: StudioVector3;
}
export interface StudioMoney {
	amountMinor: number;
	currency: string;
}
export interface StudioProduct {
	catalogId: string;
	price: StudioMoney | null;
}
export interface StudioObject extends StudioTransform {
	id: string;
	name: string;
	category: string;
	dimensions: StudioVector3;
	product: StudioProduct | null;
}
export interface StudioSnapshot {
	designId: string;
	revision: string;
	geometry: { floor: [number, number][]; height: number };
	openings: { id: string; kind: "door" | "window"; position: StudioVector3; dimensions: StudioVector3 }[];
	objects: StudioObject[];
	selectedObjectIds: string[];
	budget: StudioMoney | null;
}
export interface StudioBinding {
	designId: string;
	tabId: string;
}
export interface StudioRegistration extends StudioBinding {
	label: string;
	contractVersion: typeof STUDIO_CONTRACT_VERSION;
}
export interface StudioContextUpdate {
	generation: string;
	sequence: number;
	snapshot: StudioSnapshot;
}
export interface StudioSelectionUpdate {
	generation: string;
	sequence: number;
	selectedObjectIds: string[];
}
export type StudioAction =
	| { type: "move"; position: StudioVector3 }
	| { type: "rotate"; rotation: StudioVector3 }
	| { type: "remove" }
	| { type: "replace"; catalogId: string; expectedCatalogId: string | null };
export interface StudioCommand {
	commandId: string;
	conversationId: string;
	binding: StudioBinding;
	expectedRevision: string;
	objectId: string;
	action: StudioAction;
	reversesCommandId?: string;
}
export type StudioErrorCode =
	| "studio_unavailable"
	| "wrong_binding"
	| "invalid_target"
	| "invalid_arguments"
	| "stale_revision"
	| "save_rejected"
	| "outcome_unknown";
export interface StudioError {
	code: StudioErrorCode;
	message: string;
}
export type StudioCommandResult =
	| {
			commandId: string;
			status: "saved";
			revision: string;
			snapshot: StudioSnapshot;
			before: StudioTransform;
			after: StudioTransform | null;
	  }
	| { commandId: string; status: "rejected"; error: StudioError }
	| { commandId: string; status: "unknown"; message: string };
export type StudioMailboxRequest = {
	requestId: string;
	generation: string;
	binding: StudioBinding;
} & ({ type: "context" } | { type: "execute"; command: StudioCommand });
export type StudioResponse = {
	requestId: string;
	generation: string;
} & (
	| { type: "context"; context: StudioContextUpdate }
	| { type: "result"; result: StudioCommandResult; context?: StudioContextUpdate }
	| { type: "error"; error: StudioError }
);
export interface StudioMailboxState {
	requests: StudioMailboxRequest[];
}
export interface StudioConnection {
	readonly mailbox: ReplicatedState<StudioMailboxState>;
	register(registration: StudioRegistration, context: Context): Promise<{ generation: string }>;
	/** Call after subscribing to mailbox; requests remain until answered. */
	ready(generation: string, context: Context): Promise<void>;
	publishContext(update: StudioContextUpdate, context: Context): Promise<void>;
	publishSelection(update: StudioSelectionUpdate, context: Context): Promise<void>;
	respond(response: StudioResponse, context: Context): Promise<void>;
}
export const StudioConnection = defineService<StudioConnection>("livi.studio-connection");
export type StudioPhase = "offline" | "ready";
export interface StudioSummary extends StudioBinding {
	label: string;
	phase: StudioPhase;
}
export interface StudioDirectory {
	readonly state: ReplicatedState<{ studios: StudioSummary[] }>;
}
export const StudioDirectory = defineService<StudioDirectory>("livi.studio-directory");
export interface StudioSessionState {
	binding: StudioBinding | null;
	phase: StudioPhase;
	snapshot: StudioSnapshot | null;
}
export interface StudioSession {
	readonly state: ReplicatedState<StudioSessionState>;
	bind(binding: StudioBinding | null, context: Context): Promise<void>;
}
export const StudioSession = defineService<StudioSession>("livi.studio-session");
