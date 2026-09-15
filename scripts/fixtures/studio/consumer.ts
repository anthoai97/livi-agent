import type { Context, RemoteServices } from "@earendil-works/chord";
import { Client } from "@earendil-works/pi-client";
import {
	AgentController,
	type AgentPromptRequest,
	CATALOG_RECOMMENDATION_KIND,
	type CatalogRecommendationDetails,
	isCatalogRecommendationDetails,
	SessionDirectory,
	SessionManagement,
	STUDIO_CONTRACT_VERSION,
	type StudioCommand,
	type StudioCommandResult,
	StudioConnection,
	StudioDirectory,
	StudioSession,
	type StudioSnapshot,
	sanitizeCatalogProduct,
	Transcript,
	type TranscriptState,
} from "@livi/studio-contracts";

// Typecheck the same service acquisition and nested state used by an external chat UI.
export async function connectChat(services: RemoteServices, context: Context) {
	const directory = services.use(SessionDirectory);
	const management = services.use(SessionManagement);
	const session = directory.state.value?.sessions[0] ?? (await management.create({}, context));
	await management.attach(session.sessionId, context);
	const transcript = services.use(Transcript);
	const unsubscribe = transcript.state.subscribe((state) => renderTranscript(state));
	const request: AgentPromptRequest = {
		message: "Add two chairs",
		action: { type: "add_asset", selectedProductId: "catalog-chair", quantity: 2 },
	};
	const controller = services.use(AgentController);
	const response = await controller.prompt(request, context);
	if (!response.accepted) throw new Error(response.error.message);
	await controller.requestAbort(response.operationId, context);
	unsubscribe();
	await management.detach(context);
}

function renderTranscript(state: TranscriptState): string[] {
	const snapshot = state.snapshot;
	if (!snapshot) return [];
	// Unresolved declaration dependencies must not silently erase nested types.
	// @ts-expect-error Operation status is a string union, not a number.
	const invalidStatus: number = snapshot.operation?.status;
	void invalidStatus;
	const text = snapshot.transcript.flatMap((entry) => {
		const id: string = entry.id;
		if (entry.type !== "message") return [id];
		if (entry.message.role === "toolResult" && isCatalogRecommendationDetails(entry.message.details)) {
			return entry.message.details.products.map((product) => sanitizeCatalogProduct(product).name);
		}
		return [id];
	});
	for (const content of snapshot.operation?.streamingMessage?.content ?? []) {
		if (content.type === "text") text.push(content.text);
	}
	if (snapshot.lastResult?.status === "failed") text.push(snapshot.lastResult.error?.message ?? "Failed");
	if (state.event?.type === "message_end") text.push(state.event.entryId ?? "");
	return text;
}

const recommendations: CatalogRecommendationDetails = {
	kind: CATALOG_RECOMMENDATION_KIND,
	searchId: "example-search",
	products: [],
	resolvedConstraints: {},
	pagination: { limit: 6, offset: 0, exhausted: true },
	shownIds: [],
	binding: null,
	followUp: null,
};
if (!isCatalogRecommendationDetails(recommendations)) throw new Error("Catalog helper import failed");
for (const [service, id] of [
	[SessionDirectory, "pi.session-directory"],
	[SessionManagement, "pi.session-management"],
	[AgentController, "pi.agent-controller"],
	[Transcript, "pi.transcript"],
	[StudioConnection, "livi.studio-connection"],
	[StudioDirectory, "livi.studio-directory"],
	[StudioSession, "livi.studio-session"],
] as const) {
	if (service.id !== id) throw new Error(`Unexpected service identity: ${service.id}`);
}

const snapshot: StudioSnapshot = {
	designId: "example-design",
	revision: "example-revision",
	geometry: {
		floor: [
			[0, 0],
			[6, 0],
			[6, 4],
			[0, 4],
		],
		height: 2.8,
	},
	openings: [],
	objects: [
		{
			id: "placed-chair-1",
			name: "Chair",
			category: "chair",
			dimensions: [1, 1, 1],
			position: [1, 1, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
			product: { catalogId: "catalog-chair", price: { amountMinor: 12999, currency: "USD" } },
		},
	],
	selectedObjectIds: [],
	budget: { amountMinor: 500000, currency: "USD" },
};
const command: StudioCommand = {
	commandId: "example-command",
	conversationId: "example-chat",
	binding: { designId: "example-design", tabId: "example-tab" },
	expectedRevision: "example-revision",
	objectId: "placed-chair-1",
	action: { type: "replace", catalogId: "new-catalog-chair", expectedCatalogId: "catalog-chair" },
};
const addition: StudioCommand = {
	commandId: "example-add",
	conversationId: "example-chat",
	binding: command.binding,
	expectedRevision: snapshot.revision,
	action: { type: "add", catalogId: "catalog-chair", quantity: 2 },
};
const creation: StudioCommandResult = {
	commandId: addition.commandId,
	status: "saved",
	kind: "create",
	revision: "saved-revision",
	snapshot,
	created: [
		{ objectId: "new-chair-1", transform: { position: [2, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
		{ objectId: "new-chair-2", transform: { position: [3, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
	],
};
const batch: StudioCommand = {
	commandId: "example-batch",
	conversationId: command.conversationId,
	binding: command.binding,
	expectedRevision: "43",
	action: {
		type: "batch",
		edits: [
			{ objectId: "placed-chair-1", action: { type: "move", position: [2, 1, 0] } },
			{ action: { type: "add", catalogId: "catalog-chair", quantity: 2 } },
		],
	},
};
const batchResult: StudioCommandResult = {
	commandId: batch.commandId,
	status: "saved",
	kind: "batch",
	revision: "46",
	snapshot: { ...snapshot, revision: "46" },
	results: [
		{
			kind: "edit",
			before: { position: [1, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
			after: { position: [2, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
		},
		{ kind: "create", created: creation.created },
	],
};
console.log(
	STUDIO_CONTRACT_VERSION,
	StudioConnection,
	typeof Client,
	command.action,
	batch.action,
	batchResult.results,
	addition.action,
	creation.created,
	snapshot.budget,
	snapshot.objects[0]?.product,
);
