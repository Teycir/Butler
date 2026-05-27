export const INIT_SCHEMA_SQL = `
-- Enable WAL mode for high concurrency
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  client_type TEXT NOT NULL,
  status TEXT CHECK(status IN ('alive', 'stale', 'dead', 'recovering')) DEFAULT 'alive',
  last_heartbeat INTEGER NOT NULL,
  last_event_seen INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Event Store (Append-only, Immutable)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON stringified payload
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_project_id_id ON events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_events_project_session ON events(project_id, session_id);

-- Sequences Table for atomic, race-free counter generation (e.g. TODO task IDs)
CREATE TABLE IF NOT EXISTS sequences (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Snapshots Table
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Memories Table (Universal Knowledge Base)
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('summary', 'decision', 'rule', 'wiki')),
  content TEXT NOT NULL,
  embedding BLOB, -- Optional binary Buffer of Float32 embedding vector
  importance REAL CHECK(importance >= 0.0 AND importance <= 1.0) DEFAULT 0.5,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Index for searching memories by project
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, type);
`;
