import { type Context, defineService } from "@earendil-works/chord";

export interface AgentPromptRequest {
  message: string;
}
export interface AgentOperationError { code: string; message: string }
export type AgentOperationResponse =
  | { accepted: true; operationId: string; error: null }
  | { accepted: false; operationId: string | null; error: AgentOperationError };
export interface AgentController {
  prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
  requestAbort(operationId: string, context: Context): Promise<void>;
}
export const AgentController = defineService<AgentController>("pi.agent-controller");
