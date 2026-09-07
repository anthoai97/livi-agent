import { startLiviServer } from "./server.js";

const server = await startLiviServer({
	port: Number(process.env.PORT ?? 3001),
	host: process.env.HOST ?? "127.0.0.1",
	dataDirectory: process.env.LIVI_DATA_DIR,
	modelId: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
	apiKey: process.env.GEMINI_API_KEY,
});
console.log(`Livi listening on http://${process.env.HOST ?? "127.0.0.1"}:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void server.close().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
}
