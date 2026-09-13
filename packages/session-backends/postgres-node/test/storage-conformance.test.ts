import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	type ConformanceCase,
	createStorageConformance,
	type StorageFixture,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { connectDatabase, encodeId } from "../src/database.ts";
import { PostgresStorage } from "../src/index.ts";
import { connectionString, resetDatabase } from "./setup.ts";

const SESSION_ID = "session";
const NOW = 1_700_000_000_000;
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describe(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

registerConformance(
	"PostgresStorage conformance",
	createStorageConformance(async () => {
		await resetDatabase();
		const { pool } = await connectDatabase(connectionString);
		await pool.query(
			"INSERT INTO livi_sessions.sessions(id,created_at,storage_version,next_seq,usage_payload) VALUES($1,$2,1,1,$3)",
			[encodeId(SESSION_ID), NOW, JSON.stringify(EMPTY_USAGE)],
		);
		const storage = new PostgresStorage(pool, { sessionId: SESSION_ID, now: () => NOW });
		return {
			storage,
			async [Symbol.asyncDispose]() {
				await storage.close(BACKGROUND_CONTEXT);
				await pool.end();
			},
		} satisfies StorageFixture;
	}),
);
