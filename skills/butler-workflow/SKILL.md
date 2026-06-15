---
name: butler-workflow
description: Orchestrate Butler MCP for multi-agent coordination, persistent memory, and cross-session continuity.
---

# Butler Workflow

Orchestrate Butler MCP for multi-agent coordination, persistent memory, and cross-session continuity.

## When to Use

- Starting/ending work sessions
- Managing shared TODOs across agents
- Persisting important decisions/context
- Coordinating with other active sessions
- Handing off work between sessions
- Searching historical context

## Session Lifecycle

**On session start:**
```
1. sessionregister with unique session_id (e.g., "kiro-main-1")
2. Check active sessions to avoid conflicts
3. Review unclaimed TODOs for this project
```

**During work:**
```
1. Send sessionheartbeat every 15-30 seconds
2. Create TODOs for upcoming work: todoadd
3. Claim TODOs before starting: todoclaim
4. Complete TODOs after finishing: todocomplete
5. Store important decisions: memorystore
```

**On session end:**
```
1. Create handoff: handoffcreate (summary, completed, pending)
2. Unclaim active TODOs: todounclaim
3. Disconnect: sessiondisconnect
```

## TODO Workflow

**Creating TODOs:**
- Use `todoadd` for shared tasks
- Set priority: low/medium/high
- Keep titles concise and actionable

**Claiming work:**
- Always `todoclaim` before starting to prevent conflicts
- Other agents see claimed TODOs in their context
- Claims auto-expire if session goes stale

**Completing:**
- `todocomplete` with version number (optimistic locking)
- Marks TODO as done, visible to all sessions

## Memory Management

**Store decisions:**
```
memorystore:
  type: decision | summary | rule | wiki
  content: The actual information
  importance: 0.0-1.0 (use 0.7+ for critical info)
```

**Search context:**
```
memorysearch:
  query: Natural language search
  limit: Number of results (default 10)
```

**Clean up:**
```
memorydelete:
  memory_id: ID of memory to remove
```

## Multi-Agent Coordination

**Messages:** Send to specific session
```
messagesend:
  to_session_id: Target session
  content: Message text
```

**Broadcasts:** Notify all sessions
```
broadcast:
  content: Important announcement
```

**Check active sessions:**
- Review butler://projects/{id}/sessions resource
- See who's working on what
- Avoid conflicting work

## Rules & Guidelines

**Add persistent rules:**
```
ruleadd:
  content: "Always run tests before committing"
```

**Remove rules:**
```
ruleremove:
  rule_id: UUID of rule to remove
```

## Decision Records

**Log architectural decisions:**
```
decisionrecord:
  decision_id: "ADR-001"
  title: "Use PostgreSQL for state"
  context: "Need ACID guarantees"
  decision: "Chosen PostgreSQL over MongoDB"
```

## Best Practices

1. **Always register** at session start
2. **Heartbeat regularly** to maintain presence
3. **Claim before work** to prevent conflicts
4. **Handoff on exit** for continuity
5. **Store critical context** in memory
6. **Search before asking** to avoid duplication
7. **Broadcast major changes** that affect others
8. **Clean up stale TODOs** periodically

## Anti-Patterns

- Don't skip session registration (context invisible)
- Don't work on TODOs without claiming
- Don't forget handoffs (next session blind)
- Don't store trivial info (noise in search)
- Don't ignore active session conflicts

## Example: Starting Work

```
1. sessionregister(project_id, session_id="kiro-feature-auth", client_type="Kiro CLI")
2. Check active sessions → see "cursor-main-1" working on auth
3. messagesend(to="cursor-main-1", content="Working on auth tests, will coordinate")
4. todolist(status="pending") → review unclaimed work
5. todoclaim(todo_id=42) → claim "Write auth integration tests"
6. [Do the work]
7. todocomplete(todo_id=42, version=1)
8. memorystore(type="summary", content="Auth tests cover OAuth flow", importance=0.8)
9. handoffcreate(summary="Completed auth tests", completed_todos=["Auth tests"])
10. sessiondisconnect()
```
