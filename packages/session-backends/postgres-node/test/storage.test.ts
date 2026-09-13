import {
	BACKGROUND_CONTEXT as context,
	insertEntry,
	insertUsage,
	setValue,
	value,
} from "@earendil-works/pi-agent-core";
import type { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connectDatabase, EMPTY_STATS, encodeId } from "../src/database.ts";
import { PostgresStorage } from "../src/storage.ts";
import { connectionString, resetDatabase } from "./setup.ts";

let pool: Pool;
let storage: PostgresStorage;
beforeEach(async () => {
	await resetDatabase();
	({ pool } = await connectDatabase(connectionString));
	await pool.query(
		"INSERT INTO livi_sessions.sessions(id,created_at,storage_version,next_seq,usage_payload) VALUES($1,1,1,1,$2)",
		[encodeId("session"), JSON.stringify(EMPTY_STATS.usage)],
	);
	storage = new PostgresStorage(pool, { sessionId: "session" });
});
afterEach(async () => {
	await storage.close(context);
	await pool.end();
});

it("round trips colliding UTF-16 identifiers, addresses, JSON and binary prefix ordering", async () => {
	const ids = ["\u0000", "\ud800", "\ud801", "\ufffd", "😀"];
	await storage.commit(
		ids.map((id) =>
			insertEntry({ id, parentId: null, type: "custom", customType: id, data: { text: "\u0000\ud800" } }),
		),
		context,
	);
	expect([...(await storage.getEntries(ids, context))].map(([id]) => id)).toEqual(ids);
	await expect(
		storage.commit([insertUsage({ id: ids[0]!, usage: EMPTY_STATS.usage, adjustment: false })], context),
	).rejects.toThrow();
	const keys = ["%", "_", "\\", "\ud800", "\ud801", "\ue000", "\u{10000}", "\ufffd"];
	await storage.commit(
		keys.map((key) => setValue(value("test", key), { key })),
		context,
	);
	expect((await storage.scanValues(value("test"), context)).map((item) => item.address.key)).toEqual([
		"%",
		"\\",
		"_",
		"\ud800",
		"\ud801",
		"\ue000",
		"\ufffd",
		"\u{10000}",
	]);
	for (const key of keys) expect((await storage.getValue(value("test", key), context))?.value).toEqual({ key });
	expect((await storage.scanValues(value("test", "%"), context)).map((item) => item.address.key)).toEqual(["%"]);
});

it("rejects unsafe BIGINT allocation without changing durable writes", async () => {
	await pool.query("UPDATE livi_sessions.sessions SET next_seq=$1", [String(Number.MAX_SAFE_INTEGER)]);
	await expect(storage.commit([setValue(value("test"), 1)], context)).rejects.toThrow(/Unsafe/);
	expect(await storage.getValue(value("test"), context)).toBeUndefined();
	await pool.query("UPDATE livi_sessions.sessions SET next_seq='9007199254740992'");
	await expect(storage.commit([], context)).rejects.toThrow(/Unsafe/);
});

it("drains an admitted blocked commit and rejects new work while closing", async () => {
	const blocker = await pool.connect();
	await blocker.query("BEGIN");
	await blocker.query("SELECT 1 FROM livi_sessions.sessions FOR UPDATE");
	const admitted = storage.commit([setValue(value("test"), 1)], context);
	const closing = storage.close(context);
	await expect(storage.commit([], context)).rejects.toThrow(/closed/);
	await blocker.query("COMMIT");
	blocker.release();
	await admitted;
	await closing;
	expect(pool.totalCount).toBe(pool.idleCount);
});

it("does not replay a transaction after a lost COMMIT acknowledgement", async () => {
	const client = await pool.connect();
	const original = client.query;
	let commits = 0;
	client.query = new Proxy(original, {
		apply(target, thisArg, args: unknown[]) {
			if (args[0] === "COMMIT") {
				commits++;
				return Promise.resolve(Reflect.apply(target, thisArg, args)).then(() => {
					throw new Error("lost COMMIT acknowledgement");
				});
			}
			return Reflect.apply(target, thisArg, args);
		},
	});
	client.release();
	await expect(storage.commit([setValue(value("test"), "durable")], context)).rejects.toThrow(/acknowledgement/);
	expect(commits).toBe(1);
	expect((await storage.getValue(value("test"), context))?.value).toBe("durable");
	expect((await storage.commit([], context)).firstSeq).toBe(2);
	expect(pool.waitingCount).toBe(0);
});

it("surfaces real connection termination, rolls back and releases its client", async () => {
	const client = await pool.connect();
	const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
	const killer = await pool.connect();
	const original = client.query;
	client.query = new Proxy(original, {
		apply(target, thisArg, args: unknown[]) {
			if (typeof args[0] === "string" && args[0].startsWith("UPDATE livi_sessions.sessions SET next_seq")) {
				return killer
					.query("SELECT pg_terminate_backend($1)", [pid])
					.then(() => Reflect.apply(target, thisArg, args));
			}
			return Reflect.apply(target, thisArg, args);
		},
	});
	client.release();
	await expect(storage.commit([setValue(value("test"), "transient")], context)).rejects.toThrow();
	killer.release();
	expect(await storage.getValue(value("test"), context)).toBeUndefined();
	expect((await storage.commit([], context)).firstSeq).toBe(1);
});
