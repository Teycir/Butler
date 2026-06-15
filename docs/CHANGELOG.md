# Changelog

All notable changes to Butler are documented here, grouped by date from git history.

## [0.2.0] - 2026-06-10

### Added
- **Butler Workflow Skill**: Portable skill package for AI agents with comprehensive Butler coordination patterns
  - Session lifecycle (register → heartbeat → handoff → disconnect)
  - TODO workflow (create → claim → work → complete)
  - Memory management patterns
  - Multi-agent coordination best practices
- Skill metadata frontmatter for agent discovery

### Changed
- **MCP Server**: Hardened markdown rendering in context resources
- **Memory Tools**: Updated schema for clearer memory type documentation

### Fixed
- **Vector Search**: Skip embedding BLOBs during non-vector searches (performance)

### Documentation
- Added butler-workflow skill installation guide to README
- Updated repository anatomy to include skills directory
- Expanded table of contents with skill section

## [0.1.0] - 2026-05-28

### Added - Phase 4: Developer Experience

#### CLI Tools
- **`npm run status`**: Standalone CLI reads `.butler/butler.db` directly
  - Shows active sessions, TODOs by priority, handoffs, conflicts, broadcasts
  - Supports `--project`, `--db`, `--json`, `--help` flags
  
- **`npm run dashboard`**: Local web dashboard at `http://localhost:7888`
  - Live SSE updates every 5 seconds
  - Shows session status, TODOs with claims, broadcasts, conflicts
  - Read-only observational UI
  - Supports `--port`, `--host`, `--db` flags

#### MCP Tools
- **`eventsexport`**: Export raw event log as JSON or NDJSON
  - Filters: `since`, `until`, `session_id`, `event_type`, `limit`
  - Default 500, max 5000 events
  - Full backup/restore capability

#### Database
- **Versioned Schema Migrations**: Proper migration system with tracking table
  - Each migration runs in transaction with rollback on failure
  - Idempotent: applied once, never re-run
  - `VERSIONED_MIGRATIONS` array as single source of truth
  - 5 backfill migrations (v1-v5) for pre-4.4 databases

### Fixed
- Build: Removed unused imports (`formatTimestamp`, `truncate`, `getRecentBroadcasts`, `getEvents`)
- TypeScript: Fixed type narrowing errors in `dispatchTool` with `as any` cast for strict literal unions

### Added - Phase 3: Multi-Agent Coordination

- **TODO Claims**: `todoclaim`/`todounclaim` tools for conflict prevention
- **Direct Messaging**: `messagesend` for session-to-session communication
- **Broadcasts**: `broadcast` for all-session announcements
- **Conflict Detection**: Tracks concurrent TODO mutations within 10-second windows
- Surfaced in `/context` under "Recent Coordination Conflicts"

### Added - Phase 2: Handoff Quality

#### Handoff Improvements
- Structured diff view instead of raw event counts
- TODO labels include titles: `"Fix login bug" (ID 3)`
- Ungraceful handoffs show formatted `diff_summary` with emoji prefixes
- Track `deleted_todos` and `rules_removed` separately
- Deduplicate wiki topics in handoff payloads

#### New Resources
- **`butler://projects/{id}/diff?since={eventId}`**: Compact changelog since event ID
  - Returns `total_changes`, `entries` (chronological), `grouped` (by type)
  - URI parser supports query strings

#### Context Enhancements
- Freshness badge: 🟢 (live) or 🔴 (stale)
- Shows age of last heartbeat (e.g., `5s ago`, `12m ago`)
- Raw JSON includes `staleness` block with detailed metrics
- Added `last_event_id` for incremental diff fetching

#### Quality Scoring
- **`handoffcreate`**: Computes quality score (0-100%)
  - Low (<40%): ⚠️ coaching message
  - High (≥80%): ✅ confirmation
- Scores rendered inline in `/context` resource

## [0.0.1] - 2026-05-27

### Initial Release

#### Core Features
- **Event-Sourced Architecture**: Append-only event log as ground truth
- **Materialized Views**: Cached project state from event replay
- **Session Management**: Ephemeral sessions with heartbeat monitoring
- **SQLite Backend**: WAL mode, zero external dependencies

#### MCP Tools
- **Session**: `sessionregister`, `sessionheartbeat`, `sessiondisconnect`
- **TODOs**: `todoadd`, `todocomplete`, `todoupdate`, `tododelete`, `todolist`
- **Knowledge**: `wikiupdate`, `ruleadd`, `ruleremove`, `decisionrecord`, `handoffcreate`
- **Memory**: `memorystore`, `memorysearch`, `memorydelete`, `projectlist`

#### MCP Resources
- `butler://projects/{id}/context`: Unified markdown context
- `butler://projects/{id}/todos`: Active task list
- `butler://projects/{id}/wiki`: Knowledge base
- `butler://projects/{id}/sessions`: Session registry
- `butler://projects/{id}/memories`: Memory log

#### Vector Search
- Pure JS TF-IDF implementation
- Zero Python/external dependencies
- Cosine similarity for semantic search

#### Installation
- Automated installers for Linux/macOS/Windows
- Auto-configures Claude Desktop, Kiro CLI, Kilo Code, VS Code, Cursor
- Zero-config project defaults via `.butler/project.json`

### Fixed
- **Critical: Race Condition**: Wrapped disconnect in `db.transaction()` to prevent duplicate events
- **Critical: Handoff Bug**: Fixed pending_todos to exclude same-session create+complete
- **Session Lifecycle**: Changed dead session query to catch missed heartbeats
- **Test Non-Determinism**: Moved `lastSnapshotTime` to closure for isolation
- **Session Recovery**: Update `last_event_seen` on reconnect
- **Snapshot Retention**: Keep last 3 snapshots instead of 1

### Performance
- Removed `structuredClone` on cache read path

### Documentation
- Comprehensive README with architecture diagram
- Installation guide for 5 AI clients
- API reference for all tools and resources
- Examples and best practices
- Related projects section
