import { Client } from "@earendil-works/pi-client";
import {
	STUDIO_CONTRACT_VERSION,
	type StudioCommand,
	StudioConnection,
	type StudioSnapshot,
} from "@livi/studio-contracts";

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
	action: { type: "rotate", rotation: [0, 0, Math.PI / 2] },
};
console.log(
	STUDIO_CONTRACT_VERSION,
	StudioConnection,
	typeof Client,
	command.action,
	snapshot.budget,
	snapshot.objects[0]?.product,
);
