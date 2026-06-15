# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-06-15

### Added
- **feat(tests):** Add automated test to enforce `SNAPSHOT_SCHEMA_VERSION` bump discipline on `ProjectState` schema changes.
- **feat(tests):** Add integration test for `eventsexport` to verify seamless since/until pagination.
- **docs(readme):** Add documentation for LangGraph checkpointing and multi-agent orchestrator features.
- **feat(cache):** Implement `lastAccessed` tracking and a 30-minute Time-To-Live (TTL) eviction policy in `projectCache` to prevent unbounded memory retention.
- **feat(tests):** Add dedicated unit test suite for `projectEvent` pure projections in `tests/projections.test.ts`.
- **feat(tests):** Add cross-platform `tests/run.ts` runner script to coordinate sequential test runs even if early phases fail.

### Fixed
- **fix(sync):** Wrap `synccontext` claim transfer, timeline alignment, and broadcasts in a database transaction to ensure atomic operations.
- **fix(sync):** Re-materialize and re-check target peer status inside the transaction to eliminate the claim transfer race condition with completed/deleted tasks.
- **fix(store):** Add check for `db.inTransaction` to prevent nested transaction errors inside `getNextSequenceValue` under `better-sqlite3`.
- **fix(sync):** Extract active peer heartbeat locking time limit to a named constant `PEER_ACTIVE_LOCK_SECONDS`.
- **fix(vector):** Parameterize query limits inside `getMemories` to eliminate SQL injection surface.
- **fix(vector):** Wrap FTS MATCH queries in a try-catch block inside `searchMemories` to handle malformed queries gracefully without throwing, returning `degraded` and `reason` metadata flags.
- **fix(vector):** Warn users inside the `memorysearch` tool response when the query degraded due to an FTS syntax error.
- **fix(cache):** Upgrade `projectCache` eviction logic from FIFO (Map entry insertion order) to a true Least Recently Used (LRU) policy using the `lastAccessed` timestamp.
- **fix(lifecycle):** Pre-compute handoff payloads outside the transaction blocks in `gracefulDisconnect` and `startLifecycleMonitor` to eliminate potential deadlock risks.
- **fix(mcp):** Append startup timestamps to `syntheticSessionId` to avoid collisions on OS PID recycling.
- **fix(store):** Parameterize `SNAPSHOT_RETENTION_COUNT` inside the snapshot cleanup query instead of using string template interpolation.
- **fix(tests):** Add integration test to verify FTS Match query failure degradation and error warning output.

### Changed & Refactored
- **refactor(format):** Remove duplicate local formatting code in `context.ts` and `memory.tools.ts` by importing common formatting utilities (`formatAge`, `formatRecencyDays`, `formatTimestamp`) from `lib/format.ts`.

### Chores & Maintenance
- **chore(package):** Fill empty `author` field in `package.json` with `"Teycir Ben Soltane <teycir@pxdmail.net>"`.

## [1.0.0] - 2026-06-10

### Added
- **feat(mcp):** Harden markdown rendering and update memory tool schema
- **feat(skills):** Add butler workflow skill and documentation
- **feat(dev-exp):** Implement Phase 4 observability and versioned migrations
- **feat(coordination):** Implement multi-agent synchronization and conflict detection
- **feat(lifecycle):** Implement phase 2 handoff quality and diffing capabilities
- **feat(core):** Implement snapshot versioning and markdown sanitization
- **feat(mcp):** Add zero-friction startup protocol instructions
- **feat(core):** Centralize configuration and implement input validation
- **feat(mcp):** Implement todo management and enhance state persistence
- **feat(core):** Enhance session management and event materialization
- **feat:** Initialize project structure

### Fixed
- **fix(mcp):** Sanitize tool identifiers by removing dots
- **fix(system):** Harden session lifecycle and data integrity
- **fix(core):** Resolve session lifecycle race conditions and handoff logic bugs

### Changed & Refactored
- **refactor(db):** Migrate memory indexes to versioned migration v6
- **refactor(db):** Enhance schema integrity and implement additive migrations
- **refactor(mcp):** Transition rules to keyed storage and expand toolset
- **refactor(core):** Improve state management and mcp output formatting
- **refactor(mcp):** Harden session registration and handoff validation
- **refactor(core):** Optimize session management and vector search performance
- **refactor(core):** Optimize session lifecycle and event materialization

### Performance
- **perf(vector):** Skip embedding BLOBs during non-vector searches

### Documentation
- **docs(butler-workflow):** Add metadata frontmatter to skill documentation
- **docs(readme):** Update documentation structure and architecture diagram
- **docs:** Remove product roadmap
- **docs:** Add license and improve system stability
- **docs(readme):** Update installation guide and architecture diagram
- **docs(readme):** Add project banner and assets
- **docs(readme):** Add donation info and related projects section
- **docs(readme):** Expand project overview and quickstart guide
- **docs:** Add README and documentation directory
- **docs:** Add .gitignore and project specification

### Tested
- **test(integration):** Refactor crypto imports in integration tests

### Chores & Maintenance
- **chore:** Untrack dist/ (already in .gitignore)
- **chore(install):** Implement release deployment to dedicated directory
- **chore(docs):** Reorganize documentation and assets
- **chore(readme):** Update project badges
