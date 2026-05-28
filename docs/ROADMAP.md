# Butler — Product Roadmap

> Status: Living document. Phases are sequential by priority, not strict calendar quarters.

---

## Current State (v1.0)

Butler is a working, tested MCP server with:
- Event-sourced SQLite state (TODOs, wiki, rules, decisions, handoffs)
- Session lifecycle monitoring with stale/dead detection
- Snapshot + integrity verification for fast cold starts
- TF-IDF semantic memory search with hybrid scoring
- Optimistic locking on all mutations
- Auto-structured handoffs on disconnect

**The weakest link:** agents must call `sessionregister` on startup for any of this to activate.
If an agent ignores the protocol, Butler is invisible. Every phase below is ordered to
eliminate that dependency surface, then deepen the value once adoption is solved.

---

## Phase 1 — Zero-Friction Adoption ✅
**Goal: Butler works even when agents do nothing special.**

### 1.1 — `.butler/project.json` Convention ✅
Introduce a per-repo config file committed to version control:

```json
{
  "project_id": "my-repo",
  "description": "Optional human-readable name"
}
```

Butler reads this on every tool call as a fallback `project_id` when none is passed.
Agents in that working directory inherit the project automatically — no argument required.

**Impact:** Eliminates the need for agents to know or pass `project_id`. One-time user
action (create the file), zero ongoing agent burden.

### 1.2 — Auto-Register on First Tool Call ✅
When an agent calls any tool without a registered session, Butler silently auto-registers
a synthetic session (`auto-<client>-<hash>`) and continues rather than throwing.
A warning is appended to the response so the agent is informed but not blocked.

**Impact:** Butler degrades gracefully instead of being completely invisible when
an agent skips `sessionregister`.

### 1.3 — Install Script Emits Ready-to-Paste System Prompt ✅
After installation, `install.sh` / `install.ps1` prints a minimal system prompt
snippet and offers to copy it to the clipboard:

```
On startup: call projectlist, then sessionregister (project_id from .butler/project.json,
session_id = "<client>-<4 random chars>", client_type = your tool name).
Heartbeat every 15s. Before exit: handoffcreate then sessiondisconnect.
```

This is a one-time user action that makes every future session frictionless.

**Impact:** Solves adoption for power users immediately, with no code changes to Butler.

### 1.4 — Auto-Register on MCP `notifications/initialized` ✅
Hook the MCP `notifications/initialized` event to pre-create a session the moment
a client connects, before any tool is called. The `project_id` is resolved via:
1. `.butler/project.json` in the detected working directory
2. A `BUTLER_DEFAULT_PROJECT` env var
3. A `default` project as last resort

**Impact:** True zero-agent-action path. Butler activates on connection, not on
correct tool invocation.

---

## Phase 2 — Handoff Quality ✅
**Goal: The context agents receive on startup is actually useful, not just correct.**

### 2.1 — Smarter Handoff Summaries ✅
### 2.2 — Handoff Diff Resource ✅
### 2.3 — Context Staleness Signals ✅
### 2.4 — Agent-Narrated Handoff Quality Score ✅

---

## Phase 3 — Multi-Agent Coordination
**Goal: Two agents working simultaneously actually coordinate, not just coexist.**

### 3.1 — Conflict Detection on TODOs
When two sessions call `todocomplete` or `todoupdate` on the same TODO within a short
window, append a `TODO_CONFLICT` event and surface a warning in both sessions' next
context read. Currently the second write wins silently; this makes contention visible.

### 3.2 — Agent-to-Agent Messaging
New tool: `message.send(to_session_id, content)` — appends a `MESSAGE_SENT` event
targetted at a specific session. The recipient sees it in their next context fetch
under a new `📬 Messages` section. Enables lightweight async coordination
("I'm about to refactor auth.ts — hold off on that area").

### 3.3 — Work Claiming
New tool: `todo.claim(todo_id)` — marks a TODO as being actively worked by the
calling session. Other agents see it as claimed in the context resource, preventing
duplicate work. Claim expires automatically when the session goes stale.

### 3.4 — Broadcast Events
New tool: `broadcast(message)` — appends a `BROADCAST` event visible to all active
sessions in their next context read. Useful for "I'm starting a major refactor" type
announcements without targeting a specific agent.

---

## Phase 4 — Developer Experience ✅
**Goal: Butler is pleasant to observe, debug, and extend.**

### 4.1 — `butler status` CLI Command
A standalone CLI command (no MCP required) that reads the local `.butler/butler.db`
and prints a human-readable project summary: active sessions, open TODOs, recent
handoffs, last event timestamp. Useful for developers inspecting Butler state directly.

### 4.2 — Web Dashboard (Local)
Optionally serve a local read-only web UI on `localhost:7888` showing live project
state, session heartbeat activity, and the event log. Purely observability — no writes
through the UI. Helps developers trust Butler by making the state visible.

### 4.3 — Event Log Export
New tool: `events.export(since?, format?)` — exports the raw event log as JSON or
NDJSON for external tooling, auditing, or migration. Pairs with snapshot import for
full backup/restore flows.

### 4.4 — Schema Migration Tooling
Replace the current "swallow errors on ALTER TABLE" migration approach with a versioned
migration runner that logs applied migrations and supports rollback declarations.
Reduces the operational risk of schema changes across Butler versions.

---

## Deferred / Explicitly Out of Scope

| Item | Reason deferred |
|---|---|
| Real-time push to agents (WebSocket/SSE) | MCP stdio transport is pull-only; requires transport change with unclear client support |
| Built-in authentication / multi-user ACL | Out of scope for local stdio model; revisit if cloud sync lands |
| Vector DB integration (Pinecone, Weaviate) | Violates local-first principle; dense embedding via Ollama is the right answer |
| GUI agent builder | Scope creep; Butler is infrastructure, not a product shell |

---

## Priority Summary

| Phase | Theme | Unlocks |
|---|---|---|
| **1** | Zero-friction adoption | Butler works without agent cooperation |
| **2** | Handoff quality | Context agents receive is actually actionable |
| **3** | Multi-agent coordination | Concurrent agents collaborate, not just coexist |
| **4** | Developer experience | Operators can observe and trust Butler |
