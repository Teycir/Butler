# Butler Changelog

## [Unreleased] - 2026-05-27

### Fixed (Second Review)
- **Critical: gracefulDisconnect Race Condition**: Wrapped entire disconnect sequence in `db.transaction()` to prevent concurrent disconnect calls from creating duplicate events.

- **Critical: Handoff pending_todos Logic Bug**: Fixed `generateStructuredHandoff` to exclude TODOs that were both created and completed in the same session. Now tracks created and completed IDs separately and filters correctly.

- **Session Lifecycle Gap**: Changed dead session query from `WHERE status = 'stale'` to `WHERE status IN ('alive', 'stale')` to catch sessions that missed heartbeats but were never marked stale (e.g., if Butler was down).

- **Test Non-Determinism**: Moved `lastSnapshotTime` from module-level to lifecycle monitor closure to prevent state leakage across test runs.

### Performance
- **Removed Unnecessary Clone**: Eliminated `structuredClone` on cache read path in `materializeProject`. Only clone on write-back to cache, reducing O(n) overhead on every read.

### Code Quality
- **Removed Dead Code**: Deleted unused `eventCount` variable from materializer that was incremented but never used.

---

### Fixed (First Review)
- **Session Recovery Bug**: `registerSession` now correctly updates `last_event_seen` to the recovery event ID when a session reconnects. Previously, the recovery event was appended but `last_event_seen` was not updated, causing the recovery event to be included in subsequent handoffs.

- **Snapshot Retention**: Modified `createSnapshot` to keep the last 3 snapshots instead of deleting all previous ones. This provides fallback recovery options if the latest snapshot is corrupted.

### Added
- **RULE_REMOVED Event Handler**: Added `case 'RULE_REMOVED'` to `projectEvent()` in materializer to properly handle rule removal events.

- **todo.update Tool**: New MCP tool for updating TODO task title, priority, or status with optimistic version checking.

- **todo.delete Tool**: New MCP tool for deleting TODO tasks with optimistic version checking.

- **rule.remove Tool**: New MCP tool for removing persistent development guideline rules.

### Changed
- **memory.store Validation**: Added optional session validation to `memory.store` tool. If `session_id` is provided, it will be validated before storing the memory.

### Technical Details

#### Bug Fixes
1. **Session Recovery** (`src/coordinator/lifecycle.ts`):
   - Changed UPDATE query to include `last_event_seen = ?` parameter
   - Passes `event.id` to ensure recovery event is tracked

2. **Snapshot Retention** (`src/events/store.ts`):
   - Replaced simple `event_id < ?` deletion with subquery keeping top 3 snapshots
   - Prevents loss of recovery fallback if latest snapshot fails

#### New Features
3. **RULE_REMOVED Handler** (`src/events/materializer.ts`):
   - Filters removed rule from state array
   - Maintains consistency with event-sourced architecture

4. **TODO Management Tools** (`src/mcp/server.ts`):
   - `todo.update`: Supports partial updates (title, priority, status)
   - `todo.delete`: Removes TODO from materialized state
   - Both use optimistic locking with version checking

5. **Rule Management** (`src/mcp/server.ts`):
   - `rule.remove`: Appends RULE_REMOVED event
   - Validates session before removal

6. **Memory Store Validation** (`src/mcp/server.ts`):
   - Optional session validation when `session_id` provided
   - Maintains backward compatibility (session_id not required)

### Testing
All integration tests pass successfully:
- Session lifecycle and project insertion
- Heartbeats and ghost session rejection
- Atomic sequence counters
- Incremental materialization caching
- Intent-based memory retrieval
- Graceful disconnect and handoffs
