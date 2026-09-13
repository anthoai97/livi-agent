import {
	branchTip,
	BACKGROUND_CONTEXT as context,
	entryLabel,
	insertEntry,
	setValue,
	value,
} from "@earendil-works/pi-agent-core";
import { Pool } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeId } from "../src/database.ts";
import { PostgresSessionRepo } from "../src/repo.ts";
import type { PostgresStorage } from "../src/storage.ts";
import { connectionString, resetDatabase } from "./setup.ts";

let repo: PostgresSessionRepo;
const repos: PostgresSessionRepo[] = [];
beforeEach(async () => {
	await resetDatabase();
	repo = await PostgresSessionRepo.connect({ connectionString });
	repos.push(repo);
});
afterEach(async () => {
	await Promise.all(repos.splice(0).map((repo) => repo.close(context)));
	vi.restoreAllMocks();
});
function poolOf(repo: PostgresSessionRepo): Pool {
	return Reflect.get(repo, "pool") as Pool;
}

it("releases reservations before delete/failure resolves and preserves other sessions", async () => {
	const session = await repo.create({ id: "same" }, context);
	const other = await repo.create({ id: "other" }, context);
	await expect(repo.open(session.metadata, context)).rejects.toThrow(/already open/);
	await expect(repo.delete(session.metadata, context)).rejects.toThrow(/already open/);
	await session.close(context);
	await repo.delete(session.metadata, context);
	const recreated = await repo.create({ id: "same" }, context);
	await recreated.close(context);
	await expect(repo.open({ ...recreated.metadata, repositoryId: "wrong" }, context)).rejects.toThrow(
		/another repository/,
	);
	await (await repo.open(recreated.metadata, context)).close(context);
	await expect(repo.open({ ...recreated.metadata, id: "missing" }, context)).rejects.toThrow(/Missing/);
	await (await repo.create({ id: "missing" }, context)).close(context);
	await expect(repo.delete({ ...recreated.metadata, id: "absent" }, context)).rejects.toThrow(/Missing/);
	expect((await repo.list(undefined, context)).map((m) => m.id).sort()).toEqual(["missing", "other", "same"]);
	await other.setName("still writable", context);
});

it("round trips session IDs, branch names and entry labels with lone surrogates", async () => {
	for (const id of ["\u0000", "\ud800", "\ud801", "\ufffd"]) {
		const session = await repo.create({ id }, context);
		const branch = await session.createBranch("\ud800", null, context);
		const entryId = await branch.appendCustomEntry("note", undefined, context);
		await session.setLabel(entryId, "label", context);
		await session.mutate(
			(m) =>
				m.commit(
					[
						insertEntry({ id: "\ud800", parentId: null, type: "custom", customType: "note" }),
						setValue(entryLabel("\ud800"), "surrogate label"),
					],
					context,
				),
			context,
		);
		await session.close(context);
		const reopened = await repo.open(session.metadata, context);
		expect(reopened.metadata.id).toBe(id);
		expect(await reopened.getLabel("\ud800", context)).toBe("surrogate label");
		expect(await (await reopened.branch("\ud800", context))?.getTipId(context)).toBe(entryId);
		await reopened.close(context);
	}
});

it("queues fork behind raw admitted commits without acquiring the mutation barrier", async () => {
	const source = await repo.create({ id: "source" }, context);
	const owners = Reflect.get(repo, "owners") as Map<string, { storage: PostgresStorage }>;
	const storage = owners.get("source")!.storage;
	const blocker = await poolOf(repo).connect();
	await blocker.query("BEGIN");
	await blocker.query("SELECT 1 FROM livi_sessions.sessions FOR UPDATE");
	const admitted = storage.commit([setValue(value("app"), "before")], context);
	const barrier = await source.beginMutation(context);
	const fork = repo.fork(source.metadata, { scope: "tree", id: "fork" }, context);
	await blocker.query("COMMIT");
	blocker.release();
	await admitted;
	const destination = await fork;
	expect((await destination.getValue(value("app"), context))?.value).toBe("before");
	await barrier.end(context);
});

it("independent fork snapshot cannot mix values and entries from later commits", async () => {
	const source = await repo.create({ id: "source" }, context);
	await source.mutate(
		(m) =>
			m.commit(
				[
					insertEntry({ id: "before", parentId: null, type: "custom", customType: "note" }),
					setValue(value("app"), "before"),
					setValue(branchTip("data"), "before"),
				],
				context,
			),
		context,
	);
	const independent = await PostgresSessionRepo.connect({ connectionString });
	repos.push(independent);
	const client = await poolOf(independent).connect();
	const valuesRead = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const original = client.query;
	client.query = new Proxy(original, {
		apply(target, thisArg, args: unknown[]) {
			if (typeof args[0] === "string" && args[0].startsWith("SELECT payload,seq FROM livi_sessions.entries")) {
				valuesRead.resolve();
				return proceed.promise.then(() => Reflect.apply(target, thisArg, args));
			}
			return Reflect.apply(target, thisArg, args);
		},
	});
	client.release();
	const pending = independent.fork(source.metadata, { scope: "tree", id: "fork" }, context);
	await valuesRead.promise;
	await source.mutate(
		(m) =>
			m.commit(
				[
					insertEntry({ id: "later", parentId: "before", type: "custom", customType: "note" }),
					setValue(value("app"), "later"),
					setValue(branchTip("data"), "later"),
				],
				context,
			),
		context,
	);
	proceed.resolve();
	const fork = await pending;
	expect((await fork.getValue(value("app"), context))?.value).toBe("before");
	expect((await fork.findEntries({}, context)).map((e) => e.id)).toEqual(["before"]);
	expect((await source.findEntries({}, context)).length).toBe(2);
});

it("destination write failure publishes no partial session and permits immediate retry", async () => {
	const source = await repo.create({ id: "source" }, context);
	await source.setName("copied", context);
	const pool = poolOf(repo);
	await pool.query(`CREATE FUNCTION livi_sessions.fail_fork() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.session_id='${encodeId("fork")}' THEN RAISE EXCEPTION 'destination failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_fork BEFORE INSERT ON livi_sessions.scalar_values FOR EACH ROW EXECUTE FUNCTION livi_sessions.fail_fork()`);
	await expect(repo.fork(source.metadata, { scope: "tree", id: "fork" }, context)).rejects.toThrow(
		/destination failure/,
	);
	expect((await repo.list(undefined, context)).map((m) => m.id)).toEqual(["source"]);
	await (await repo.create({ id: "fork" }, context)).close(context);
});

it("close drains admitted create and attempts all owners before ending pool", async () => {
	const first = await repo.create({ id: "first" }, context);
	const second = await repo.create({ id: "second" }, context);
	const closeFirst = first.close.bind(first);
	vi.spyOn(first, "close").mockImplementation(async (c) => {
		await closeFirst(c);
		throw new Error("cleanup failure");
	});
	const closedSecond = vi.spyOn(second, "close");
	const admitted = repo.create({ id: "admitted" }, context);
	const closing = repo.close(context);
	await admitted;
	await expect(closing).rejects.toThrow(/shutdown/);
	expect(closedSecond).toHaveBeenCalled();
	expect(poolOf(repo).ended).toBe(true);
	repos.splice(repos.indexOf(repo), 1);
});

it("rejects unsupported migrations and closes the startup pool", async () => {
	await poolOf(repo).query("UPDATE livi_sessions.schema_version SET version=999");
	const end = vi.spyOn(Pool.prototype, "end");
	await expect(PostgresSessionRepo.connect({ connectionString })).rejects.toThrow(/Unsupported/);
	expect(end).toHaveBeenCalledTimes(1);
});
