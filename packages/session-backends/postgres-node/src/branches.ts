import type { Entry, EntryStructure, StorageBranchScan } from "@earendil-works/pi-agent-core";
import type { PoolClient } from "pg";
import { decodeId, encodeId, safeNumber } from "./database.ts";

// Each entry belongs to one segment. Divergence references its parent's segment
// and sequence, so appending a new branch never copies the whole ancestry.
export async function appendEntryToBranchIndex(client: PoolClient, sessionId: string, entry: Entry): Promise<void> {
	const id = encodeId(entry.id);
	let branchId = id;
	if (entry.parentId !== null) {
		const parentId = encodeId(entry.parentId);
		const extended = await client.query<{ branch_id: string }>(
			`UPDATE livi_sessions.branch_meta SET tip_entry_id=$3,tip_seq=$4
   WHERE session_id=$1 AND tip_entry_id=$2 RETURNING branch_id`,
			[sessionId, parentId, id, entry.seq],
		);
		if (extended.rows[0]) branchId = extended.rows[0].branch_id;
		else {
			await client.query(
				`INSERT INTO livi_sessions.branch_meta(session_id,branch_id,tip_entry_id,tip_seq,base_branch_id,base_seq)
    SELECT $1,$3,$3,$4,branch_id,entry_seq FROM livi_sessions.branch_entries WHERE session_id=$1 AND entry_id=$2`,
				[sessionId, parentId, id, entry.seq],
			);
		}
	} else
		await client.query(
			"INSERT INTO livi_sessions.branch_meta(session_id,branch_id,tip_entry_id,tip_seq) VALUES($1,$2,$2,$3)",
			[sessionId, id, entry.seq],
		);
	await client.query(
		"INSERT INTO livi_sessions.branch_entries(session_id,branch_id,entry_id,entry_seq,entry_type) VALUES($1,$2,$3,$4,$5)",
		[sessionId, branchId, id, entry.seq, entry.type],
	);
}
interface BranchRow {
	id: string;
	parent_id: string | null;
	seq: string;
	timestamp: string;
	type: Entry["type"];
	custom_type: string | null;
	payload?: string;
}
export async function scanBranch(
	client: PoolClient,
	sessionId: string,
	query: StorageBranchScan,
	structure: boolean,
): Promise<Entry[] | EntryStructure[]> {
	const exists = await client.query("SELECT 1 FROM livi_sessions.branch_entries WHERE session_id=$1 AND entry_id=$2", [
		sessionId,
		encodeId(query.start),
	]);
	if (!exists.rowCount) throw new Error(`Unknown branch start: ${query.start}`);
	const asc = query.order === "oldestFirst";
	const rows = await client.query<BranchRow>(
		`WITH RECURSIVE segments AS (
  SELECT b.branch_id, b.entry_seq AS upper_seq, m.base_branch_id, m.base_seq
  FROM livi_sessions.branch_entries b JOIN livi_sessions.branch_meta m USING(session_id,branch_id)
  WHERE b.session_id=$1 AND b.entry_id=$2
  UNION ALL SELECT m.branch_id,s.base_seq,m.base_branch_id,m.base_seq
  FROM segments s JOIN livi_sessions.branch_meta m ON m.session_id=$1 AND m.branch_id=s.base_branch_id
 ), path AS (
  SELECT b.* FROM segments s JOIN livi_sessions.branch_entries b ON b.session_id=$1 AND b.branch_id=s.branch_id AND b.entry_seq<=s.upper_seq
 ), boundary AS (
  SELECT ${asc ? "MIN" : "MAX"}(entry_seq) AS stop_seq FROM path WHERE entry_id=$3 OR entry_type=$4
 ) SELECT e.id,e.parent_id,e.seq,e.timestamp,e.type,e.custom_type${structure ? "" : ",e.payload"}
 FROM path b JOIN livi_sessions.entries e ON e.session_id=b.session_id AND e.id=b.entry_id CROSS JOIN boundary
 WHERE (boundary.stop_seq IS NULL OR e.seq ${asc ? "<=" : ">="} boundary.stop_seq)
 AND ($5::text IS NULL OR e.type=$5) AND ($6::text IS NULL OR e.custom_type=$6)
 AND ($7::bigint IS NULL OR e.seq ${asc ? ">" : "<"} $7)
 ORDER BY e.seq ${asc ? "ASC" : "DESC"} LIMIT $8`,
		[
			sessionId,
			encodeId(query.start),
			query.stopAtId === undefined ? null : encodeId(query.stopAtId),
			query.stopAtType ?? null,
			query.type ?? null,
			query.customType === undefined ? null : encodeId(query.customType),
			query.cursor?.seq ?? null,
			query.limit === undefined ? null : Math.max(0, query.limit),
		],
	);
	return rows.rows.map((row) => {
		const base = {
			id: decodeId(row.id),
			parentId: row.parent_id === null ? null : decodeId(row.parent_id),
			seq: safeNumber(row.seq),
			timestamp: safeNumber(row.timestamp),
			type: row.type,
			...(row.custom_type === null ? {} : { customType: decodeId(row.custom_type) }),
		};
		return structure ? base : { ...(JSON.parse(row.payload!) as Entry), ...base };
	});
}
