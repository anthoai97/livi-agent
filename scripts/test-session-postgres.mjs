import { spawnSync } from "node:child_process";

if (!process.env.TEST_SESSION_DATABASE_URL) {
	throw new Error(
		"TEST_SESSION_DATABASE_URL is required and must name a disposable database; tests destroy livi_sessions",
	);
}
for (const args of [
	["--filter", "@earendil-works/pi-session-backend-postgres-node", "test"],
	[
		"--filter",
		"@livi/server",
		"exec",
		"tsx",
		"--test",
		"--test-concurrency=1",
		"test/server.test.ts",
		"test/session-postgres.test.ts",
	],
]) {
	const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
