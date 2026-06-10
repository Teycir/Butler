# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
