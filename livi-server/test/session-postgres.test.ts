import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Server } from "@earendil-works/pi-server";
import { PostgresSessionRepo } from "@earendil-works/pi-session-backend-postgres-node";
import { Pool } from "pg";
import { startLiviServer } from "../src/server.ts";

const connectionString = process.env.TEST_SESSION_DATABASE_URL;
test("configured unavailable or invalid session database rejects without SQLite fallback", async (t) => {
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-pg-failure-"));
	t.after(() => rm(dataDirectory, { recursive: true, force: true }));
	for (const sessionDatabaseUrl of ["", "sqlite://invalid", "postgres://localhost:1/unavailable?connect_timeout=1"]) {
		await assert.rejects(startLiviServer({ dataDirectory, port: 0, sessionDatabaseUrl }));
	}
	assert.deepEqual(await readdir(dataDirectory), ["server-id"]);
});

test("early service and protocol startup failures end the session pool", { skip: !connectionString }, async (t) => {
	const dataDirectory = await mkdtemp(join(tmpdir(), "livi-pg-startup-"));
	t.after(() => rm(dataDirectory, { recursive: true, force: true }));
	const ended: Pool[] = [];
	const originalEnd: (this: Pool) => Promise<void> = Pool.prototype.end;
	t.mock.method(Pool.prototype, "end", function (this: Pool) {
		ended.push(this);
		return originalEnd.call(this);
	});
	const list = t.mock.method(PostgresSessionRepo.prototype, "list", async () => {
		throw new Error("service discovery failed");
	});
	await assert.rejects(
		startLiviServer({ dataDirectory, port: 0, sessionDatabaseUrl: connectionString }),
		/service discovery/,
	);
	list.mock.restore();
	const start = t.mock.method(Server.prototype, "start", async () => {
		throw new Error("protocol start failed");
	});
	await assert.rejects(
		startLiviServer({ dataDirectory, port: 0, sessionDatabaseUrl: connectionString }),
		/protocol start/,
	);
	start.mock.restore();
	assert.equal(ended.length, 2);
	assert.ok(ended.every((pool) => pool.ended && pool.totalCount === 0));
});
