# Butler - Remaining Known Issues

This document tracks issues identified in code review that were not fixed in this pass, either because they require design decisions or are lower priority.

## 🟡 Design Issues (Not Fixed)

### 1. Snapshot Deserialization Has No Schema Validation
**Location**: `src/events/materializer.ts:197`

**Issue**: When loading a snapshot, the code does:
```typescript
state = { ...createInitialState(), ...JSON.parse(latestSnapshot.snapshot_json) };
```

If the snapshot was created on an older version of Butler with different field shapes, the spread silently accepts corrupted data. There's no validation that the deserialized state matches the expected schema.

**Impact**: Medium - Could cause runtime errors if schema changes between versions.

**Recommendation**: Add a schema version field to snapshots and validate/migrate on load.

---

### 2. Markdown Handoff Summary Unsanitized - Prompt Injection Surface
**Location**: `src/mcp/server.ts:235` (context resource)

**Issue**: The unified context resource embeds `h.summary` directly into markdown:
```typescript
markdownContext += `${h.summary}\n`;
```

If an agent stores a handoff summary with markdown syntax (e.g., `# Injected Header` or triple backticks), it corrupts the structured markdown context that other agents read. This is a prompt injection vector.

**Impact**: Low-Medium - One agent could craft a handoff that misleads another agent.

**Recommendation**: Sanitize or escape markdown special characters in user-provided handoff content, or use a structured format (JSON) instead of markdown for the context resource.

---

### 3. `memories` Table Has No `session_id` - No Audit Trail
**Location**: `src/db/schema.ts`, `src/mcp/server.ts:910`

**Issue**: The `memory.store` tool has no `session_id` parameter, and the `memories` table has no `session_id` column. This is asymmetric with every other write operation.

**Impact**: Low - No way to audit which session stored which memory, and no way to purge memories from a dead session.

**Recommendation**: Add optional `session_id` to `memory.store` and store it in the `memories` table for audit purposes.

---

### 4. `updateLastEventSeen` Post-Disconnect Affects Recovery Start Point
**Location**: `src/coordinator/lifecycle.ts:169`

**Issue**: After appending `SESSION_DISCONNECTED` event, the code calls:
```typescript
updateLastEventSeen(sessionId, event.id);
```

Since the session is now dead, this value is only used if the session is recovered. On recovery, `registerSession` preserves `last_event_seen`, meaning the next handoff after recovery starts from *after* the disconnect event, potentially missing the ungraceful handoff content.

**Impact**: Low - Design choice, may be intentional.

**Recommendation**: Document the intended behavior or adjust recovery logic to include the disconnect event in the next handoff.

---

### 5. Ordering Hazard in `deadTransition`
**Location**: `src/coordinator/lifecycle.ts:289`

**Issue**: Inside the `deadTransition` transaction:
```typescript
db.prepare(`UPDATE sessions SET status = 'dead' WHERE id = ?`).run(row.id);
const handoff = generateStructuredHandoff(row.project_id, row.id, 'ungraceful');
```

The session is marked `dead` *before* `generateStructuredHandoff` is called. If `generateStructuredHandoff` were ever to call `validateSession()` internally, it would throw because the session is dead. It doesn't currently, but this ordering is a landmine.

**Impact**: Low - Currently safe, but fragile.

**Recommendation**: Generate handoff before marking session dead, or document the ordering constraint.

---

## ✅ Issues Verified as Non-Issues

### Ghost Dependencies
**Status**: Not an issue - `esbuild`, `express`, `hono`, `cors` are transitive dependencies from `@modelcontextprotocol/sdk` and `tsx`.

### Build Script Mismatch
**Status**: Not an issue - `npm run build` uses `tsc` which is correct. The `dist/` folder matches TypeScript output.

---

## Summary

All critical bugs have been fixed. The remaining issues are design choices or low-priority improvements that don't affect correctness in the current single-threaded stdio transport mode.

**Priority for Production Use:**
1. 🔴 All critical bugs fixed ✅
2. 🟡 Consider adding snapshot schema validation before deploying to production
3. 🟡 Consider sanitizing markdown in handoff summaries if agents are untrusted
4. 🟢 Other issues are nice-to-haves
