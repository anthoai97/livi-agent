CREATE TABLE livi_sessions.sessions (
 id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, parent_session_id TEXT,
 storage_version INTEGER NOT NULL, next_seq BIGINT NOT NULL,
 message_count BIGINT NOT NULL DEFAULT 0, usage_payload TEXT NOT NULL
);
-- One shared namespace for immutable entry and usage identifiers.
CREATE TABLE livi_sessions.record_ids (
 session_id TEXT REFERENCES livi_sessions.sessions(id) ON DELETE CASCADE,
 id TEXT NOT NULL, PRIMARY KEY(session_id,id)
);
CREATE TABLE livi_sessions.entries (
 session_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT,
 seq BIGINT NOT NULL, timestamp BIGINT NOT NULL, type TEXT NOT NULL, custom_type TEXT, payload TEXT NOT NULL,
 PRIMARY KEY(session_id,id), UNIQUE(session_id,seq),
 FOREIGN KEY(session_id,id) REFERENCES livi_sessions.record_ids(session_id,id) ON DELETE CASCADE,
 FOREIGN KEY(session_id,parent_id) REFERENCES livi_sessions.entries(session_id,id)
);
CREATE INDEX entry_parent ON livi_sessions.entries(session_id,parent_id);
CREATE INDEX entry_sequence ON livi_sessions.entries(session_id,seq,type);
CREATE TABLE livi_sessions.scalar_values (
 session_id TEXT REFERENCES livi_sessions.sessions(id) ON DELETE CASCADE,
 namespace TEXT COLLATE "C" NOT NULL, key TEXT COLLATE "C" NOT NULL,
 seq BIGINT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,namespace,key)
);
CREATE TABLE livi_sessions.list_values (
 session_id TEXT REFERENCES livi_sessions.sessions(id) ON DELETE CASCADE,
 namespace TEXT COLLATE "C" NOT NULL, key TEXT COLLATE "C" NOT NULL,
 seq BIGINT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,namespace,key,seq)
);
CREATE TABLE livi_sessions.usage_ledger (
 session_id TEXT NOT NULL, id TEXT NOT NULL, seq BIGINT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(session_id,id), UNIQUE(session_id,seq),
 FOREIGN KEY(session_id,id) REFERENCES livi_sessions.record_ids(session_id,id) ON DELETE CASCADE
);
CREATE TABLE livi_sessions.branch_meta (
 session_id TEXT REFERENCES livi_sessions.sessions(id) ON DELETE CASCADE,
 branch_id TEXT NOT NULL, tip_entry_id TEXT NOT NULL, tip_seq BIGINT NOT NULL,
 base_branch_id TEXT, base_seq BIGINT, PRIMARY KEY(session_id,branch_id), UNIQUE(session_id,tip_entry_id)
);
CREATE TABLE livi_sessions.branch_entries (
 session_id TEXT REFERENCES livi_sessions.sessions(id) ON DELETE CASCADE,
 branch_id TEXT NOT NULL, entry_id TEXT NOT NULL, entry_seq BIGINT NOT NULL, entry_type TEXT NOT NULL,
 PRIMARY KEY(session_id,entry_id)
);
CREATE INDEX branch_sequence ON livi_sessions.branch_entries(session_id,branch_id,entry_seq,entry_id,entry_type);
CREATE INDEX branch_type_sequence ON livi_sessions.branch_entries(session_id,branch_id,entry_type,entry_seq,entry_id);
