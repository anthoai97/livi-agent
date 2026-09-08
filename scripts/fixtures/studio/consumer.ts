import { Client } from "@earendil-works/pi-client";
import { STUDIO_CONTRACT_VERSION, type StudioCommand, StudioConnection } from "@livi/studio-contracts";

const command: StudioCommand = {
	commandId: "example-command",
	conversationId: "example-chat",
	binding: { designId: "example-design", tabId: "example-tab" },
	expectedRevision: "example-revision",
	objectId: "placed-chair-1",
	action: { type: "rotate", rotation: [0, 0, Math.PI / 2] },
};
console.log(STUDIO_CONTRACT_VERSION, StudioConnection, typeof Client, command.action);
