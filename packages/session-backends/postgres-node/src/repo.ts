import type { Context, ForkOptions, SessionCreateOptions, SessionMetadata } from "@earendil-works/pi-agent-core";
import { createForkSnapshot, forkSnapshotWrites, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import { connectDatabase, decodeId, EMPTY_STATS, encodeId, safeNumber, transaction } from "./database.ts";
import { applyWrites, PostgresStorage, readSession, type SessionRow } from "./storage.ts";

export interface PostgresSessionMetadata extends SessionMetadata {
	repositoryId: string;
}
export interface PostgresSessionRepoOptions {
	connectionString: string;
	now?: () => number;
}
export class PostgresSessionRepo {
	private readonly pool: Pool;
	private readonly repositoryId: string;
	private readonly now: () => number;
	private readonly reservations = new Set<string>();
	private readonly owners = new Map<
		string,
		{ storage: PostgresStorage; session: StorageBackedSession<PostgresSessionMetadata> }
	>();
	private readonly operations = new Set<Promise<unknown>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private constructor(pool: Pool, repositoryId: string, now: () => number) {
		this.pool = pool;
		this.repositoryId = repositoryId;
		this.now = now;
	}
	static async connect(options: PostgresSessionRepoOptions): Promise<PostgresSessionRepo> {
		const { pool, repositoryId } = await connectDatabase(options.connectionString);
		return new PostgresSessionRepo(pool, repositoryId, options.now ?? Date.now);
	}
	private metadata(row: SessionRow): PostgresSessionMetadata {
		return {
			id: decodeId(row.id),
			createdAt: safeNumber(row.created_at),
			storageVersion: row.storage_version,
			repositoryId: this.repositoryId,
			...(row.parent_session_id === null ? {} : { parentSessionId: decodeId(row.parent_session_id) }),
		};
	}
	private checkMetadata(metadata: PostgresSessionMetadata): void {
		if (metadata.repositoryId !== this.repositoryId)
			throw new Error("PostgreSQL session metadata belongs to another repository");
		if (metadata.storageVersion !== 1)
			throw new Error(`Unsupported session storage version: ${metadata.storageVersion}`);
	}
	private admit<T>(run: () => Promise<T>, id?: string): Promise<T> {
		if (this.closed) return Promise.reject(new Error("PostgresSessionRepo is closed"));
		if (id !== undefined) {
			if (this.reservations.has(id)) return Promise.reject(new Error(`Session is already open: ${id}`));
			this.reservations.add(id);
		}
		let result: Promise<T>;
		try {
			result = run();
		} catch (error) {
			result = Promise.reject(error);
		}
		result = result.finally(() => {
			if (id !== undefined && !this.owners.has(id)) this.reservations.delete(id);
		});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.operations.add(settled);
		void settled.then(() => this.operations.delete(settled));
		return result;
	}
	private own(metadata: PostgresSessionMetadata): StorageBackedSession<PostgresSessionMetadata> {
		const storage = new PostgresStorage(this.pool, { sessionId: metadata.id, now: this.now });
		const session = new StorageBackedSession(metadata, storage, {
			onClose: () => {
				this.owners.delete(metadata.id);
				this.reservations.delete(metadata.id);
			},
		});
		this.owners.set(metadata.id, { storage, session });
		return session;
	}
	create(
		options: SessionCreateOptions | undefined,
		_context: Context,
	): Promise<StorageBackedSession<PostgresSessionMetadata>> {
		const createdAt = safeNumber(this.now());
		const id = options?.id ?? uuidv7(createdAt);
		return this.admit(async () => {
			const metadata = await transaction(this.pool, async (client) => {
				await client.query(
					`INSERT INTO livi_sessions.sessions(id,created_at,parent_session_id,storage_version,next_seq,usage_payload)
     VALUES($1,$2,$3,1,1,$4)`,
					[
						encodeId(id),
						createdAt,
						options?.parentSessionId === undefined ? null : encodeId(options.parentSessionId),
						JSON.stringify(EMPTY_STATS.usage),
					],
				);
				return this.metadata(await readSession(client, encodeId(id)));
			});
			return this.own(metadata);
		}, id);
	}
	open(metadata: PostgresSessionMetadata, _context: Context): Promise<StorageBackedSession<PostgresSessionMetadata>> {
		return this.admit(async () => {
			this.checkMetadata(metadata);
			return this.own(this.metadata(await readSession(this.pool, encodeId(metadata.id))));
		}, metadata.id);
	}
	list(_options: undefined, _context: Context): Promise<PostgresSessionMetadata[]> {
		return this.admit(async () => {
			const result = await this.pool.query<SessionRow>(
				"SELECT * FROM livi_sessions.sessions ORDER BY created_at DESC,id",
			);
			return result.rows.map((row) => {
				if (row.storage_version !== 1)
					throw new Error(`Unsupported session storage version: ${row.storage_version}`);
				return this.metadata(row);
			});
		});
	}
	delete(metadata: PostgresSessionMetadata, _context: Context): Promise<void> {
		return this.admit(
			() =>
				transaction(this.pool, async (client) => {
					this.checkMetadata(metadata);
					await readSession(client, encodeId(metadata.id), true);
					await client.query("DELETE FROM livi_sessions.sessions WHERE id=$1", [encodeId(metadata.id)]);
				}),
			metadata.id,
		);
	}
	fork(
		source: PostgresSessionMetadata,
		options: ForkOptions,
		context: Context,
	): Promise<StorageBackedSession<PostgresSessionMetadata>> {
		const createdAt = safeNumber(this.now());
		const id = options.id ?? uuidv7(createdAt);
		return this.admit(async () => {
			this.checkMetadata(source);
			const active = this.owners.get(source.id)?.storage;
			const storage = active ?? new PostgresStorage(this.pool, { sessionId: source.id });
			// snapshot() enters the raw commit queue synchronously, without the mutation barrier.
			const pending = storage.snapshot();
			let snapshot: ReturnType<typeof createForkSnapshot>;
			try {
				snapshot = createForkSnapshot(await pending, options);
			} finally {
				if (!active) await storage.close(context);
			}
			const metadata = await transaction(this.pool, async (client) => {
				await client.query(
					`INSERT INTO livi_sessions.sessions(id,created_at,parent_session_id,storage_version,next_seq,usage_payload)
     VALUES($1,$2,$3,1,$4,$5)`,
					[
						encodeId(id),
						createdAt,
						encodeId(source.id),
						safeNumber(snapshot.nextSeq),
						JSON.stringify(EMPTY_STATS.usage),
					],
				);
				await applyWrites(client, encodeId(id), forkSnapshotWrites(snapshot), structuredClone(EMPTY_STATS));
				return this.metadata(await readSession(client, encodeId(id)));
			});
			return this.own(metadata);
		}, id);
	}
	close(context: Context): Promise<void> {
		this.closed = true;
		this.closePromise ??= (async () => {
			await Promise.all([...this.operations]);
			const results = await Promise.allSettled(
				[...this.owners.values()].map(({ session }) => session.close(context)),
			);
			const errors: unknown[] = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			try {
				await this.pool.end();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length) throw new AggregateError(errors, "PostgreSQL repository shutdown failed");
		})();
		return this.closePromise;
	}
}
