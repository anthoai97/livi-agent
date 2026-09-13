import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createSessionRepoConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { PostgresSessionRepo } from "../src/index.ts";
import { connectionString, resetDatabase } from "./setup.ts";

let repo: PostgresSessionRepo;
describe("PostgresSessionRepo conformance", () => {
	for (const testCase of createSessionRepoConformance(
		async () => {
			await resetDatabase();
			repo = await PostgresSessionRepo.connect({ connectionString, now: () => 1700000000000 });
			return repo;
		},
		async () => {
			await repo.close(BACKGROUND_CONTEXT);
		},
	))
		it(`${testCase.group}: ${testCase.name}`, () => testCase.run());
});
