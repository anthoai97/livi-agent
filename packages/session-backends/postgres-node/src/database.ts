import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SessionStats } from "@earendil-works/pi-agent-core";
import { Pool, type PoolClient } from "pg";

export const EMPTY_STATS: SessionStats = {
	messageCount: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
export function safeNumber(value: string | number): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe PostgreSQL integer: ${value}`);
	return result;
}
export async function transaction<T>(
	pool: Pool,
	run: (client: PoolClient) => Promise<T>,
	readOnly = false,
): Promise<T> {
	const client = await pool.connect();
	let failed = false;
	let connectionError: Error | undefined;
	const onError = (error: Error) => {
		connectionError = error;
	};
	client.on("error", onError);
	try {
		await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
		const result = await run(client);
		if (connectionError) throw connectionError;
		// A lost COMMIT acknowledgement is never retried: the durable outcome may be unknown.
		await client.query("COMMIT");
		return result;
	} catch (error) {
		failed = true;
		try {
			await client.query("ROLLBACK");
		} catch {
			/* Discard the connection below. */
		}
		throw error;
	} finally {
		client.release(failed || connectionError !== undefined);
		client.off("error", onError);
	}
}
export async function connectDatabase(connectionString: string): Promise<{ pool: Pool; repositoryId: string }> {
	const url = new URL(connectionString);
	if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Expected a PostgreSQL session URL");
	const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
	// Idle connection loss must not become an unhandled EventEmitter error.
	pool.on("error", () => {});
	try {
		const repositoryId = await transaction(pool, async (client) => {
			await client.query("CREATE SCHEMA IF NOT EXISTS livi_sessions");
			await client.query(`CREATE TABLE IF NOT EXISTS livi_sessions.schema_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), version INTEGER NOT NULL, repository_id TEXT NOT NULL)`);
			await client.query("LOCK TABLE livi_sessions.schema_version IN EXCLUSIVE MODE");
			const result = await client.query<{ version: number; repository_id: string }>(
				"SELECT version, repository_id FROM livi_sessions.schema_version",
			);
			const row = result.rows[0];
			if (row) {
				if (row.version !== 1) throw new Error(`Unsupported PostgreSQL session schema version: ${row.version}`);
				return row.repository_id;
			}
			await client.query(await readFile(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"));
			const identity = randomUUID();
			await client.query("INSERT INTO livi_sessions.schema_version(version,repository_id) VALUES(1,$1)", [identity]);
			return identity;
		});
		return { pool, repositoryId };
	} catch (error) {
		await pool.end();
		throw error;
	}
}

// UTF-16 bytes preserve every JavaScript identifier, including NUL and lone surrogates.
export function encodeId(id: string): string {
	return Buffer.from(id, "utf16le").toString("hex");
}
export function decodeId(id: string): string {
	return Buffer.from(id, "hex").toString("utf16le");
}

// Fixed-width code points preserve UTF-8 binary order for Unicode and keep lone
// surrogates distinct. Prefixes stay prefixes; PostgreSQL never receives raw NUL.
export function encodeKey(key: string): string {
	return Array.from(key, (c) => c.codePointAt(0)!.toString(16).padStart(6, "0")).join("");
}
export function decodeKey(key: string): string {
	let result = "";
	for (let index = 0; index < key.length; index += 6)
		result += String.fromCodePoint(Number.parseInt(key.slice(index, index + 6), 16));
	return result;
}
