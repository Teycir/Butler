# Butler Persistent Multi-Agent Memory System

## Full Product & Technical Specification

### Version 1.0

---

# 1. Product Vision

## Goal

Create a persistent multi-client AI coordination system where:

* multiple AI clients can work on the same repository simultaneously
* context survives across sessions
* dead sessions recover automatically
* project memory becomes cumulative
* collaboration feels seamless
* architecture remains understandable

The system should feel:

```text
Simple like Git
Persistent like Notion
Collaborative like Figma
AI-native like Cursor
```

---

# 2. Core Philosophy

## Most Important Principle

Sessions are temporary.

Projects are permanent.

---

# 3. Mental Model (Critical for Adoption)

Users must understand the system in under 2 minutes.

The conceptual model:

```text
Project
 ├── Shared Memory
 ├── Shared TODOs
 ├── Shared Rules
 ├── Shared Wiki
 ├── Shared Decisions
 └── Live Sessions
```

Clients are just windows into the project.

Not owners of state.

---

# 4. User Experience Goals

## UX Requirements

### Must Feel:

* automatic
* invisible
* resilient
* collaborative
* low-friction

### Must NOT Feel:

* enterprise-heavy
* distributed-systems-complex
* database-centric
* synchronization-fragile

---

# 5. High-Level System Architecture

```text
                    CLIENTS
────────────────────────────────────────────

 Claude Desktop
 Cursor
 VSCode
 Codex
 Kiro CLI
 OpenCode
 Custom Agents

────────────────────────────────────────────
                MCP TRANSPORT
────────────────────────────────────────────

        HTTP / SSE / stdio

────────────────────────────────────────────
                 DISPATCHER
────────────────────────────────────────────

 Routes requests
 Authenticates clients
 Normalizes commands

────────────────────────────────────────────
          SESSION COORDINATOR
────────────────────────────────────────────

 Presence
 Event Bus
 Conflict Resolution
 Memory Hydration
 Context Assembly
 Session Recovery

────────────────────────────────────────────
             MEMORY ENGINE
────────────────────────────────────────────

 Event Store
 Summaries
 Embeddings
 Snapshots
 Retrieval
 Ranking

────────────────────────────────────────────
             MATERIALIZED STATE
────────────────────────────────────────────

 TODOs
 Rules
 Wiki
 Handoffs
 Decisions
 Sessions

────────────────────────────────────────────
                  STORAGE
────────────────────────────────────────────

 SQLite (WAL mode)
 + sqlite-vss / vector support
```

---

# 6. Core Concepts

# 6.1 Project

The permanent container.

Everything belongs to a project.

```json
{
  "project_id": "butler",
  "name": "Butler MCP",
  "created_at": "...",
  "default_branch": "main"
}
```

---

# 6.2 Session

A temporary live connection.

```json
{
  "session_id": "claude-desktop-12",
  "project_id": "butler",
  "client_type": "Claude Desktop",
  "status": "alive"
}
```

Sessions:

* connect
* heartbeat
* disconnect
* recover

Sessions are NOT authoritative.

---

# 6.3 Event

The atomic unit of truth.

Everything meaningful becomes an event.

Examples:

```text
TODO_CREATED
TODO_COMPLETED
RULE_ACCEPTED
DECISION_RECORDED
FILE_MODIFIED
SESSION_CONNECTED
HANDOFF_CREATED
```

---

# 6.4 Materialized State

Derived current state.

Example:

```text
Current TODO list
Current wiki
Current rules
```

Computed from events.

---

# 6.5 Snapshot

Compressed project checkpoint.

Allows fast recovery.

---

# 7. Simplicity Layer (Critical)

Users should NOT need to understand:

* event sourcing
* CRDTs
* distributed systems
* vector databases

Users should only see:

```text
Shared Memory
Shared Tasks
Shared Context
```

---

# 8. MVP Scope

## Required MVP Features

### Included

* multi-client sessions
* heartbeat tracking
* shared TODOs
* shared wiki
* automatic handoffs
* session recovery
* semantic memory retrieval
* project summaries
* snapshots
* event log

### Excluded Initially

* CRDTs
* branch merging
* distributed databases
* cloud sync
* realtime cursor sharing
* collaborative editing

---

# 9. Session Lifecycle

# 9.1 Session Connect

## Flow

```text
Client Connects
    ↓
Authenticate
    ↓
Register Session
    ↓
Load Latest Snapshot
    ↓
Replay Recent Events
    ↓
Assemble Context
    ↓
Return Hydrated Context
```

---

# 9.2 Session Runtime

## Runtime Loop

```text
heartbeat every 15s
publish events
consume events
update summaries
refresh context
```

---

# 9.3 Session Disconnect

## Graceful Disconnect

```text
generate handoff
flush summaries
mark session offline
```

## Ungraceful Disconnect

If heartbeat expires:

```text
status = stale
```

System auto-generates:

* checkpoint
* partial handoff
* recovery marker

---

# 10. Heartbeat System

## Purpose

Detect dead sessions safely.

---

# Heartbeat Spec

```json
{
  "session_id": "kiro-cli-4",
  "timestamp": 1712345678
}
```

---

# Heartbeat Timing

| Setting            | Value |
| ------------------ | ----- |
| heartbeat interval | 15s   |
| stale timeout      | 60s   |
| dead timeout       | 5m    |

---

# Session States

| State      | Meaning               |
| ---------- | --------------------- |
| alive      | actively heartbeating |
| stale      | missed heartbeat      |
| dead       | expired               |

---

# 11. Event System

# Event Structure

```json
{
  "event_id": 9912,
  "project_id": "butler",
  "session_id": "cursor-3",
  "type": "TODO_CREATED",
  "payload": {},
  "timestamp": 1712345678
}
```

---

# Event Requirements

Events must be:

* append-only
* immutable
* ordered
* timestamped

---

# 12. Event Types

# Session Events

```text
SESSION_CONNECTED
SESSION_DISCONNECTED
SESSION_STALE
SESSION_RECOVERED
```

---

# Task Events

```text
TODO_CREATED
TODO_UPDATED
TODO_COMPLETED
TODO_DELETED
```

---

# Knowledge Events

```text
WIKI_UPDATED
RULE_ADDED
DECISION_RECORDED
HANDOFF_CREATED
```

---

# Memory Events

```text
SUMMARY_CREATED
MEMORY_EXTRACTED
SNAPSHOT_CREATED
```

---

# 13. Retrieval System

# Purpose

Restore relevant context automatically.

---

# Retrieval Pipeline

```text
User Prompt
    ↓
Intent Extraction
    ↓
Semantic Search
    ↓
Rank Memories
    ↓
Build Context Packet
    ↓
Inject Into Model
```

---

# Retrieval Sources

## Tier 1 — Immediate

Recent interactions.

---

## Tier 2 — Working

Open TODOs
Recent decisions
Current wiki

---

## Tier 3 — Long-Term

Semantic memory search.

---

# 14. Memory Ranking

## Formula

```text
score =
similarity * 0.5 +
recency * 0.2 +
importance * 0.2 +
project relevance * 0.1
```

---

# 15. Automatic Summarization

# Why

Raw chats become unusable.

---

# Strategy

## During Session

Rolling summaries.

---

## On Session End

Generate:

* completed work
* unresolved tasks
* architecture changes
* blockers
* next actions

---

# Summary Example

```json
{
  "summary": "Implemented dispatcher retries. TODO persistence incomplete.",
  "importance": 0.82
}
```

---

# 16. Snapshot System

# Purpose

Fast project recovery.

---

# Snapshot Trigger Rules

Create snapshot:

* every 100 events
* every 30 minutes
* before shutdown
* before migrations

---

# Snapshot Structure

```json
{
  "snapshot_id": 12,
  "event_id": 9921,
  "project_state": {}
}
```

---

# 17. Conflict Resolution

# MVP Strategy

Use optimistic locking.

---

# Entity Versioning

```json
{
  "todo_id": 44,
  "version": 7
}
```

---

# Update Rule

Write succeeds only if:

```text
incoming_version == current_version
```

Otherwise:

* reject
* refresh
* retry

---

# 18. Context Assembly

# Final Context Packet

```json
{
  "project": {},
  "active_sessions": [],
  "recent_decisions": [],
  "open_todos": [],
  "relevant_memories": [],
  "latest_handoff": {}
}
```

---

# 19. Storage Design

# SQLite Requirements

Use:

* WAL mode
* concurrent reads
* prepared statements
* indexed timestamps

---

# Tables

## projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER
);
```

---

## sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  client_type TEXT,
  status TEXT,
  last_heartbeat INTEGER,
  last_event_seen INTEGER
);
```

---

## events

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  session_id TEXT,
  type TEXT,
  payload TEXT,
  created_at INTEGER
);
```

---

## snapshots

```sql
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  event_id INTEGER,
  snapshot_json TEXT,
  created_at INTEGER
);
```

---

## memories

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  type TEXT,
  content TEXT,
  embedding BLOB,
  importance REAL,
  created_at INTEGER
);
```

---

# 20. MCP Resources

# Read Resources

```text
/projects/{id}/context
/projects/{id}/todos
/projects/{id}/wiki
/projects/{id}/sessions
/projects/{id}/memory/search
```

---

# Write Tools

```text
todo.add
todo.complete
wiki.update
rule.add
handoff.create
session.heartbeat
memory.store
```

---

# 21. Session Recovery Flow

# Example

```text
Claude dies unexpectedly
    ↓
Session becomes stale
    ↓
Kiro continues working
    ↓
Events continue accumulating
    ↓
Claude reconnects
    ↓
Replay unseen events
    ↓
Rebuild context
    ↓
Resume naturally
```

---

# 22. Ease-of-Use Features

# Automatic Context Restore

User opens client:

```text
"Continue working"
```

System already knows:

* open TODOs
* recent changes
* unresolved blockers
* architecture state

---

# Automatic Handoffs

Generated automatically.

User never manually writes summaries.

---

# Shared TODO Awareness

All clients see:

* same tasks
* same priorities
* same progress

---

# 23. User-Facing Language

Avoid:

* event sourcing
* vector retrieval
* materialized views

Use:

* project memory
* shared context
* live sessions
* recovery
* automatic continuity

---

# 24. Recommended Tech Stack

| Layer         | Tech          |
| ------------- | ------------- |
| Runtime       | Node.js / Bun |
| DB            | SQLite        |
| Vectors       | sqlite-vss    |
| Transport     | MCP HTTP/SSE  |
| Embeddings    | local or API  |
| Serialization | JSON          |
| Auth          | token-based   |

---

# 25. Scaling Plan

# Phase 1

Single-machine SQLite.

---

# Phase 2

Postgres + pgvector.

---

# Phase 3

Distributed coordination.

---

# 26. Security Model

# Sessions

Each session has:

* token
* project scope
* permissions

---
---

# 27. Observability

# Metrics

Track:

* active sessions
* stale sessions
* replay duration
* retrieval latency
* summary generation time

---

# 28. Failure Recovery

# System Crash

On restart:

```text
load latest snapshot
replay events
rebuild state
resume sessions
```

---

# 29. Product Positioning

# What This Is

```text
Persistent AI coordination layer for coding agents.
```

---

# What This Is NOT

```text
Not a chat app.
Not just memory.
Not an IDE plugin.
```

---

# 30. The Adoption Strategy

## Why Developers Will Adopt

Because it solves:

```text
"I lost my context."
"I switched tools."
"My session died."
"The agent forgot."
"We have multiple agents running."
```

without introducing complexity.

---

# 31. MVP Success Criteria

The system succeeds when:

A developer can:

* close Claude
* continue in Cursor
* reopen Claude later

and all clients:

* share memory
* share TODOs
* share decisions
* recover automatically

with no manual copy/paste.

---

# 32. Final Product Summary

## Butler

A persistent shared memory and coordination layer for AI coding agents.

### Features

* automatic continuity
* multi-client persistence
* shared project memory
* event-based recovery
* semantic retrieval
* resilient sessions
* collaborative AI workflows

### Design Goals

* easy to understand
* easy to adopt
* hard to break
* minimal operational burden
* SQLite-first
* local-first
* AI-native
