export const INIT_SCHEMA_SQL = `
-- Enable WAL mode for high concurrency
PRAGMA journal_mode = WAL;
-- FULL sync ensures committed transactions survive OS crashes — critical for shared agent memory
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
-- Prevent SQLITE_BUSY under parallel agent writes
PRAGMA busy_timeout = 5000;

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT    PRIMARY KEY,
  project_id      TEXT    NOT NULL,
  client_type     TEXT    NOT NULL,
  status          TEXT    CHECK(status IN ('alive', 'stale', 'dead')) DEFAULT 'alive',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_heartbeat  INTEGER NOT NULL,
  last_event_seen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Index for session lifecycle queries
CREATE INDEX IF NOT EXISTS idx_sessions_status_heartbeat ON sessions(status, last_heartbeat);
-- Index for per-project session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, status);

-- Event Store (Append-only, Immutable)
-- Source of truth for all shared state. Never update or delete rows.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT    NOT NULL,
  session_id TEXT    NOT NULL,  -- which agent wrote this event
  type       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,  -- JSON stringified payload
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Composite index for incremental materialization (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_events_project_id_id ON events(project_id, id);
-- Index for per-session audit queries
CREATE INDEX IF NOT EXISTS idx_events_project_session ON events(project_id, session_id);
-- Index for time-range queries (e.g. "what happened in the last hour")
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, created_at);

-- Sequences Table for atomic, race-free counter generation (e.g. TODO task IDs)
CREATE TABLE IF NOT EXISTS sequences (
  project_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Snapshots Table
-- Stores periodic materialized state for fast startup.
-- Integrity: sha256_hex of snapshot_json stored alongside to detect corruption at load time.
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT    NOT NULL,
  event_id      INTEGER NOT NULL,  -- last event ID included in this snapshot
  snapshot_json TEXT    NOT NULL,
  sha256_hex    TEXT    NOT NULL,  -- hex-encoded SHA-256 of snapshot_json for integrity check
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Memories Table (Semantic Knowledge Base)
-- Stores embeddings for fuzzy/semantic search across summaries, decisions, rules, wiki.
-- source_event_id links back to the event that originated this memory, preventing drift.
CREATE TABLE IF NOT EXISTS memories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT    NOT NULL,
  type           TEXT    NOT NULL CHECK(type IN ('summary', 'decision', 'rule', 'wiki')),
  content        TEXT    NOT NULL,
  source_ref     TEXT,            -- canonical reference key (e.g. decision_id, wiki topic, rule_id)
  source_event_id INTEGER,        -- event ID that produced this memory (traceability)
  session_id     TEXT,            -- session that stored this memory (audit trail)
  embedding      BLOB,            -- Optional Float32 binary embedding vector
  importance     REAL    CHECK(importance >= 0.0 AND importance <= 1.0) DEFAULT 0.5,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- Index for searching memories by project and type
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, type);
-- Index for traceability: find memory from its source event
CREATE INDEX IF NOT EXISTS idx_memories_source_event ON memories(source_event_id);
-- Index for session-based audit/purge queries
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
-- Unique index: one memory entry per source_ref per project (prevents drift duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_ref ON memories(project_id, type, source_ref)
  WHERE source_ref IS NOT NULL;
`;

// Schema migrations: add columns introduced after initial deployment.
// Each statement is executed individually and errors are swallowed, making this
// idempotent — safe to run on every startup against any DB version.
export const MIGRATION_SQL = `
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'));
ALTER TABLE snapshots ADD COLUMN sha256_hex TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshots ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN source_ref TEXT;
ALTER TABLE memories ADD COLUMN source_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
`;
