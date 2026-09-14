import type {
	CommitResult,
	CommittedWrite,
	Context,
	Entry,
	EntryScan,
	EntryStructure,
	ForkSourceSnapshot,
	ListElement,
	ListReadOptions,
	SessionStats,
	Storage,
	StorageBranchScan,
	StoredValue,
	UsageRow,
	UsageScan,
	Value,
	ValueList,
	Write,
} from "@earendil-works/pi-agent-core";
import { prepareStorageCommit, resolveListReadOptions, value } from "@earendil-works/pi-agent-core";
import type { Pool, PoolClient } from "pg";
import { appendEntryToBranchIndex, scanBranch } from "./branches.ts";
import { decodeKey, EMPTY_STATS, encodeId, encodeKey, safeNumber, transaction } from "./database.ts";

const PROGRESS_FRAME_NAMESPACE = "pi.pending.assistant_frame";
const PROGRESS_TOOL_NAMESPACE = "pi.pending.tool_output";

function isProgressWrite(write: Write): boolean {
	return (
		(write.kind === "list" && write.op === "append" && write.namespace === PROGRESS_FRAME_NAMESPACE) ||
		(write.kind === "value" && write.op === "set" && write.namespace === PROGRESS_TOOL_NAMESPACE)
	);
}

interface PayloadRow {
	payload: string;
	seq: string;
}
interface ValueRow {
	namespace: string;
	key: string;
	value: string;
	seq: string;
}
export interface SessionRow {
	id: string;
	created_at: string;
	parent_session_id: string | null;
	storage_version: number;
	next_seq: string;
	message_count: string;
	usage_payload: string;
}
export async function readSession(client: Pool | PoolClient, id: string, lock = false): Promise<SessionRow> {
	const result = await client.query<SessionRow>(
		`SELECT * FROM livi_sessions.sessions WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
		[id],
	);
	const row = result.rows[0];
	if (!row) throw new Error(`Missing PostgreSQL session: ${id}`);
	if (row.storage_version !== 1) throw new Error(`Unsupported session storage version: ${row.storage_version}`);
	safeNumber(row.created_at);
	safeNumber(row.next_seq);
	return row;
}
function statsFromRow(row: SessionRow): SessionStats {
	return {
		messageCount: safeNumber(row.message_count),
		usage: JSON.parse(row.usage_payload) as SessionStats["usage"],
	};
}
function decodeEntry(row: PayloadRow): Entry {
	const entry = JSON.parse(row.payload) as Entry;
	return { ...entry, seq: safeNumber(row.seq), timestamp: safeNumber(entry.timestamp) };
}
function decodeValue<T>(row: ValueRow): StoredValue<T> {
	return {
		address: value<T>(decodeKey(row.namespace), decodeKey(row.key)),
		seq: safeNumber(row.seq),
		value: JSON.parse(row.value) as T,
	};
}
export async function applyWrites(
	client: PoolClient,
	id: string,
	writes: readonly CommittedWrite[],
	stats: SessionStats,
): Promise<void> {
	for (let index = 0; index < writes.length; index++) {
		const write = writes[index]!;
		safeNumber(write.seq);
		if (write.kind === "entry" || write.kind === "usage") {
			await client.query("INSERT INTO livi_sessions.record_ids(session_id,id) VALUES($1,$2)", [
				id,
				encodeId(write.id),
			]);
			const { kind: _kind, ...record } = write;
			if (write.kind === "entry") {
				safeNumber(write.timestamp);
				// Check before INSERT, so a self-parent cannot satisfy the foreign key.
				if (write.parentId !== null) {
					const parent = await client.query("SELECT 1 FROM livi_sessions.entries WHERE session_id=$1 AND id=$2", [
						id,
						encodeId(write.parentId),
					]);
					if (!parent.rowCount) throw new Error(`Missing parent entry: ${write.parentId}`);
				}
				await client.query(
					`INSERT INTO livi_sessions.entries(session_id,id,parent_id,seq,timestamp,type,custom_type,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
					[
						id,
						encodeId(write.id),
						write.parentId === null ? null : encodeId(write.parentId),
						write.seq,
						write.timestamp,
						write.type,
						write.customType === undefined ? null : encodeId(write.customType),
						JSON.stringify(record),
					],
				);
				await appendEntryToBranchIndex(client, id, record as Entry);
				if (write.type === "message") stats.messageCount++;
			} else {
				await client.query(
					"INSERT INTO livi_sessions.usage_ledger(session_id,id,seq,payload) VALUES($1,$2,$3,$4)",
					[id, encodeId(write.id), write.seq, JSON.stringify(record)],
				);
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
					stats.usage[key] += write.usage[key];
				for (const key of ["cacheWrite1h", "reasoning"] as const) {
					if (stats.usage[key] !== undefined || write.usage[key] !== undefined)
						stats.usage[key] = (stats.usage[key] ?? 0) + (write.usage[key] ?? 0);
				}
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
					stats.usage.cost[key] += write.usage.cost[key];
			}
		} else {
			value(write.namespace, write.key);
			const table = write.kind === "value" ? "scalar_values" : "list_values";
			if (write.op === "delete") {
				await client.query(`DELETE FROM livi_sessions.${table} WHERE session_id=$1 AND namespace=$2 AND key=$3`, [
					id,
					encodeKey(write.namespace),
					encodeKey(write.key),
				]);
			} else if (write.kind === "list") {
				// Consecutive appends can be batched without changing ordered delete/set semantics.
				const rows = [
					{
						namespace: encodeKey(write.namespace),
						key: encodeKey(write.key),
						seq: write.seq,
						value: JSON.stringify(write.value),
					},
				];
				while (index + 1 < writes.length && rows.length < 1000) {
					const next = writes[index + 1]!;
					if (next.kind !== "list" || next.op !== "append") break;
					value(next.namespace, next.key);
					rows.push({
						namespace: encodeKey(next.namespace),
						key: encodeKey(next.key),
						seq: safeNumber(next.seq),
						value: JSON.stringify(next.value),
					});
					index++;
				}
				await client.query(
					`INSERT INTO livi_sessions.list_values(session_id,namespace,key,seq,value)
     SELECT $1, namespace,key,seq,value FROM json_to_recordset($2::json) AS x(namespace text,key text,seq bigint,value text)`,
					[id, JSON.stringify(rows)],
				);
			} else {
				await client.query(
					`INSERT INTO livi_sessions.scalar_values(session_id,namespace,key,seq,value) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(session_id,namespace,key) DO UPDATE SET seq=excluded.seq,value=excluded.value`,
					[id, encodeKey(write.namespace), encodeKey(write.key), write.seq, JSON.stringify(write.value)],
				);
			}
		}
	}
	await client.query("UPDATE livi_sessions.sessions SET message_count=$2,usage_payload=$3 WHERE id=$1", [
		id,
		safeNumber(stats.messageCount),
		JSON.stringify(stats.usage),
	]);
}
export class PostgresStorage implements Storage {
	private queue: Promise<void> = Promise.resolve();
	private readonly operations = new Set<Promise<unknown>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private stats: SessionStats | undefined;
	private readonly pool: Pool;
	private readonly options: { sessionId: string; now?: () => number };
	constructor(pool: Pool, options: { sessionId: string; now?: () => number }) {
		this.pool = pool;
		this.options = { ...options, sessionId: encodeId(options.sessionId) };
	}
	private admit<T>(run: () => Promise<T>, queued = false): Promise<T> {
		if (this.closed) return Promise.reject(new Error("PostgresStorage is closed"));
		const result = queued ? this.queue.then(run) : run();
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		if (queued) this.queue = settled;
		this.operations.add(settled);
		void settled.then(() => this.operations.delete(settled));
		return result;
	}
	commit(writes: Write[], _context: Context): Promise<CommitResult> {
		return this.admit(async () => {
			if (writes.length > 0 && writes.every(isProgressWrite)) {
				return {
					firstSeq: 0,
					seqs: writes.map((_, index) => index),
					timestamp: safeNumber((this.options.now ?? Date.now)()),
					stats: this.stats ?? EMPTY_STATS,
				};
			}
			return transaction(this.pool, async (client) => {
				const row = await readSession(client, this.options.sessionId, true);
				const firstSeq = safeNumber(row.next_seq);
				const nextSeq = safeNumber(firstSeq + writes.length);
				const prepared = prepareStorageCommit(writes, firstSeq, safeNumber((this.options.now ?? Date.now)()));
				const stats = statsFromRow(row);
				await applyWrites(client, this.options.sessionId, prepared.writes, stats);
				await client.query("UPDATE livi_sessions.sessions SET next_seq=$2 WHERE id=$1", [
					this.options.sessionId,
					nextSeq,
				]);
				this.stats = stats;
				return { ...prepared.result, stats };
			});
		}, true);
	}
	getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		return this.admit(async () => {
			const rows = await this.pool.query<PayloadRow>(
				"SELECT payload,seq FROM livi_sessions.entries WHERE session_id=$1 AND id=ANY($2::text[])",
				[this.options.sessionId, ids.map(encodeId)],
			);
			const found = new Map(
				rows.rows.map((row) => {
					const entry = decodeEntry(row);
					return [entry.id, entry];
				}),
			);
			return new Map(ids.filter((id) => found.has(id)).map((id) => [id, found.get(id)!]));
		});
	}
	getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		return this.admit(async () => {
			const result = await this.pool.query<ValueRow>(
				"SELECT * FROM livi_sessions.scalar_values WHERE session_id=$1 AND namespace=$2 AND key=$3",
				[this.options.sessionId, encodeKey(address.namespace), encodeKey(address.key)],
			);
			return result.rows[0] ? decodeValue<T>(result.rows[0]) : undefined;
		});
	}
	scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		return this.admit(async () => {
			const escaped = encodeKey(prefix.key);
			const result = await this.pool.query<ValueRow>(
				"SELECT * FROM livi_sessions.scalar_values WHERE session_id=$1 AND namespace=$2 AND key LIKE $3 ORDER BY key",
				[this.options.sessionId, encodeKey(prefix.namespace), `${escaped}%`],
			);
			return result.rows.map(decodeValue<T>);
		});
	}
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		return this.admit(async () => {
			const resolved = resolveListReadOptions(options);
			const asc = resolved.order === "asc";
			const rows = await this.pool.query<ValueRow>(
				`SELECT seq,value FROM livi_sessions.list_values WHERE session_id=$1 AND namespace=$2 AND key=$3
    AND ($4::bigint IS NULL OR seq ${asc ? ">" : "<"} $4) ORDER BY seq ${asc ? "ASC" : "DESC"} LIMIT $5`,
				[
					this.options.sessionId,
					encodeKey(address.namespace),
					encodeKey(address.key),
					resolved.cursor?.seq ?? null,
					resolved.limit,
				],
			);
			return rows.rows.map((row) => ({ seq: safeNumber(row.seq), value: JSON.parse(row.value) as T }));
		});
	}
	scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		return this.admit(async () => {
			const rows = await this.pool.query<PayloadRow>(
				`SELECT payload,seq FROM livi_sessions.entries WHERE session_id=$1
    AND ($2::bigint IS NULL OR seq >= $2) AND ($3::bigint IS NULL OR seq <= $3)
    AND ($4::text IS NULL OR type=$4) AND ($5::text IS NULL OR custom_type=$5)
    ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} LIMIT $6`,
				[
					this.options.sessionId,
					query.fromSeq ?? null,
					query.toSeq ?? null,
					query.type ?? null,
					query.customType === undefined ? null : encodeId(query.customType),
					query.limit === undefined ? null : Math.max(0, query.limit),
				],
			);
			return rows.rows.map(decodeEntry);
		});
	}
	scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		return this.admit(async () => {
			const rows = await this.pool.query<PayloadRow>(
				`SELECT payload,seq FROM livi_sessions.usage_ledger WHERE session_id=$1
    AND ($2::bigint IS NULL OR seq >= $2) AND ($3::bigint IS NULL OR seq <= $3)
    ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} LIMIT $4`,
				[
					this.options.sessionId,
					query.fromSeq ?? null,
					query.toSeq ?? null,
					query.limit === undefined ? null : Math.max(0, query.limit),
				],
			);
			return rows.rows.map((row) => ({ ...(JSON.parse(row.payload) as UsageRow), seq: safeNumber(row.seq) }));
		});
	}
	scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		return this.admit(() =>
			transaction(
				this.pool,
				(client) => scanBranch(client, this.options.sessionId, query, false) as Promise<Entry[]>,
				true,
			),
		);
	}
	scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
		return this.admit(() =>
			transaction(this.pool, (client) => scanBranch(client, this.options.sessionId, query, true), true),
		);
	}
	getStats(_context: Context): Promise<SessionStats> {
		return this.admit(async () => {
			const stats = statsFromRow(await readSession(this.pool, this.options.sessionId));
			this.stats = stats;
			return stats;
		});
	}
	snapshot(): Promise<ForkSourceSnapshot> {
		return this.admit(
			() =>
				transaction(
					this.pool,
					async (client) => {
						await readSession(client, this.options.sessionId);
						const values = await client.query<ValueRow>(
							"SELECT * FROM livi_sessions.scalar_values WHERE session_id=$1 ORDER BY seq",
							[this.options.sessionId],
						);
						const entries = await client.query<PayloadRow>(
							"SELECT payload,seq FROM livi_sessions.entries WHERE session_id=$1 ORDER BY seq",
							[this.options.sessionId],
						);
						return {
							entries: entries.rows.map(decodeEntry),
							scalarValues: values.rows.map(decodeValue<unknown>),
							entriesComplete: true,
						};
					},
					true,
				),
			true,
		);
	}
	close(_context: Context): Promise<void> {
		this.closed = true;
		this.closePromise ??= Promise.all([...this.operations]).then(() => undefined);
		return this.closePromise;
	}
}
