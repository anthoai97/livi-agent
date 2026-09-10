import { type Context, defineService } from "@earendil-works/chord";

export type AgentPromptAction =
	| { type: "add_asset"; selectedProductId: string; quantity: number }
	| {
			type: "replace_asset";
			selectedProductId: string;
			targetObjectId: string;
			designId: string;
			expectedRevision: string;
			expectedCatalogId: string | null;
	  };
export interface AgentPromptRequest {
	message: string;
	action?: AgentPromptAction;
}
export interface AgentOperationError {
	code: string;
	message: string;
}
export type AgentOperationResponse =
	| { accepted: true; operationId: string; error: null }
	| { accepted: false; operationId: string | null; error: AgentOperationError };
export interface AgentController {
	prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	requestAbort(operationId: string, context: Context): Promise<void>;
}
export const AgentController = defineService<AgentController>("pi.agent-controller");
