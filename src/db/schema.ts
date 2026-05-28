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
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Composite index for incremental materialization (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_events_project_id_id ON events(project_id, id);
-- Index for per-session audit queries
CREATE INDEX IF NOT EXISTS idx_events_project_session ON events(project_id, session_id);
-- Index for time-range queries
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, created_at);

-- Sequences Table for atomic, race-free counter generation
CREATE TABLE IF NOT EXISTS sequences (
  project_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Snapshots Table
CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT    NOT NULL,
  event_id       INTEGER NOT NULL,
  snapshot_json  TEXT    NOT NULL,
  sha256_hex     TEXT    NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Memories Table (Semantic Knowledge Base)
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK(type IN ('summary', 'decision', 'rule', 'wiki')),
  content         TEXT    NOT NULL,
  source_ref      TEXT,
  source_event_id INTEGER,
  session_id      TEXT,
  embedding       BLOB,
  importance      REAL    CHECK(importance >= 0.0 AND importance <= 1.0) DEFAULT 0.5,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, type);
CREATE INDEX IF NOT EXISTS idx_memories_source_event ON memories(source_event_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_ref ON memories(project_id, type, source_ref)
  WHERE source_ref IS NOT NULL;
`;

// ─── Versioned migrations ─────────────────────────────────────────────────────
//
// This is the single migration system for Butler. Rules:
//   - Versions are dense integers starting at 1 (no gaps, never reused).
//   - Each migration runs inside a transaction; failure rolls back and surfaces
//     a clear error — nothing is silently swallowed.
//   - Migrations are applied exactly once, tracked in butler_migrations.
//   - NEVER edit a migration after it has been shipped. Add a new one instead.
//   - INIT_SCHEMA_SQL already includes all columns for fresh installs; migrations
//     here exist to bring pre-existing databases up to date.

export interface Migration {
  version:     number;
  description: string;
  up:          string[];  // SQL statements run in a single transaction
  rollback?:   string[];  // Declarative only — not auto-applied
}

export const VERSIONED_MIGRATIONS: Migration[] = [
  // v1–v4: backfill columns added incrementally to pre-4.4 databases.
  // Fresh installs already have these in INIT_SCHEMA_SQL; ALTER TABLE
  // on a column that already exists is caught and ignored gracefully.
  {
    version:     1,
    description: 'Backfill sessions.created_at for pre-4.4 databases',
    up: [`ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))`]
  },
  {
    version:     2,
    description: 'Backfill snapshots.sha256_hex for pre-4.4 databases',
    up: [`ALTER TABLE snapshots ADD COLUMN sha256_hex TEXT NOT NULL DEFAULT ''`]
  },
  {
    version:     3,
    description: 'Backfill snapshots.schema_version for pre-4.4 databases',
    up: [`ALTER TABLE snapshots ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`]
  },
  {
    version:     4,
    description: 'Backfill memories.source_ref, source_event_id, session_id for pre-4.4 databases',
    up: [
      `ALTER TABLE memories ADD COLUMN source_ref TEXT`,
      `ALTER TABLE memories ADD COLUMN source_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL`,
      `ALTER TABLE memories ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL`
    ]
  },
  {
    version:     5,
    description: 'Add index on events(project_id, type) for eventsexport filtering',
    up: [`CREATE INDEX IF NOT EXISTS idx_events_project_type ON events(project_id, type)`],
    rollback: [`DROP INDEX IF EXISTS idx_events_project_type`]
  }
  // ── Add future migrations below this line ────────────────────────────────────
  // {
  //   version:     6,
  //   description: 'Short description of what changes and why',
  //   up:          ['ALTER TABLE ...'],
  //   rollback:    []
  // }
];
