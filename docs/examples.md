# 📝 Butler: JSON-RPC and MCP Payload Traces

This document lists actual JSON payload traces and markdown resource responses returned by the Butler Model Context Protocol Server.

---

## 1. Tool Request & Response Traces

These payloads represent standard protocol transactions sent over standard input/output (`stdio`) transport.

### session.register
#### Request
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "session.register",
    "arguments": {
      "project_id": "api-hunter",
      "session_id": "claude-desktop-1",
      "client_type": "Claude Desktop Agent"
    }
  },
  "id": 1
}
```
#### Response
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Successfully registered session claude-desktop-1 for project api-hunter (Client: Claude Desktop Agent, Status: alive)"
      }
    ]
  },
  "id": 1
}
```

---

### todo.add
#### Request
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "todo.add",
    "arguments": {
      "project_id": "api-hunter",
      "session_id": "claude-desktop-1",
      "title": "Implement JWT signature bypass check",
      "priority": "high"
    }
  },
  "id": 2
}
```
#### Response
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Shared TODO successfully created! [ID: 1] \"Implement JWT signature bypass check\" (Event ID: 3)"
      }
    ]
  },
  "id": 2
}
```

---

### todo.complete (Optimistic Version Lock)
#### Request
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "todo.complete",
    "arguments": {
      "project_id": "api-hunter",
      "session_id": "claude-desktop-1",
      "todo_id": 1,
      "version": 1
    }
  },
  "id": 3
}
```
#### Response
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Shared TODO ID 1 marked as completed! (Event ID: 5)"
      }
    ]
  },
  "id": 3
}
```

---

### memory.search (TF-IDF Hybrid Ranking)
#### Request
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "memory.search",
    "arguments": {
      "project_id": "api-hunter",
      "query": "JWT signing key rules",
      "limit": 1
    }
  },
  "id": 4
}
```
#### Response
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "### Semantic Search Results for \"JWT signing key rules\"\n\n**[ID 4] RULE (Score: 98.0%, Recency: 95.0%, Intent Boost: 100.0%)**\n> Always verify JWT algorithm verification against HS256/RS256 parameters.\n\n"
      }
    ]
  },
  "id": 4
}
```

---

## 2. Resource Rehydration Packet

Below is the exact output yielded when reading the consolidated context resource `butler://projects/api-hunter/context`. 

This unified markdown packet is ingested by the connecting agent's context window, instantly rehydrating its memory.

### butler://projects/api-hunter/context

```markdown
# butler: Unified Project Context [Project: api-hunter]

## 👥 Active Live Sessions
- **claude-desktop-1** (Claude Desktop Agent) - Status: `alive` (Last Heartbeat: 2026-05-27T18:00:00.000Z)
- **cursor-editor** (Cursor IDE) - Status: `stale` (Last Heartbeat: 2026-05-27T17:55:00.000Z)

## 🎯 Shared TODOs / Task List
- [ ] [ID 2] **Verify OAuth state parameters validation** (Priority: 🔴 high, Version: 1)
- [ ] [ID 3] **Add JWT None-algorithm check tests** (Priority: 🟡 medium, Version: 1)

**Completed Tasks:**
- [x] [ID 1] **Implement JWT signature bypass check** (Version: 2)

## 📜 Materialized Shared Rules
- Always verify JWT algorithm verification against HS256/RS256 parameters.
- Never write credentials inside mock tests.

## 💡 Recent Architectural Decisions
### Decision: JWT Validation Strategy (ID: ADR-001)
**Context:** Need a robust JWT checker that avoids algorithm confusion vulnerability.
**Outcome/Decision:** Implement an explicit algorithm verification parameter check.

## 📚 Wiki / Knowledge Base
### Topic: getting-started
# Security Scanner
Run npm test to execute the JWT verification suite.
```
