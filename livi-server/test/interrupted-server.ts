import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { startLiviServer } from "../src/server.ts";

const faux = fauxProvider({ provider: "google", models: [{ id: "gemini-3.8-flash" }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	async () => {
		process.send?.({ type: "generating" });
		await new Promise<void>(() => {});
		return fauxAssistantMessage("unreachable");
	},
]);
const server = await startLiviServer({
	dataDirectory: process.argv[2],
	sessionDatabaseUrl: process.env.SESSION_DATABASE_URL,
	port: 0,
	models,
});
process.send?.({ type: "ready", serverId: server.serverId, port: server.port });
