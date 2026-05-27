import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db/database.js';
import { appendEvent, getEvents, getSessionEvents } from '../events/store.js';
import { EventRecord } from '../events/types.js';
import { materializeProject, invalidateProjectCache } from '../events/materializer.js';

export interface SessionRecord {
  id: string;
  project_id: string;
  client_type: string;
  status: 'alive' | 'stale' | 'dead';
  last_heartbeat: number;
  last_event_seen: number;
}

export function registerSession(projectId: string, sessionId: string, clientType: string): SessionRecord {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Verify/Insert project if not exists to satisfy foreign key constraints
  // Use INSERT OR IGNORE to avoid race condition on concurrent session registration
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

  // Check if session exists using explicit columns
  const existing = db.prepare(`
    SELECT id, project_id, client_type, status, last_heartbeat, last_event_seen 
    FROM sessions 
    WHERE id = ?
  `).get(sessionId) as any;

  if (existing) {
    const event = appendEvent(projectId, sessionId, 'SESSION_RECOVERED', {
      session_id: sessionId,
      client_type: clientType,
      timestamp: now
    });

    // Preserve last_event_seen from before the session died so handoffs remain accurate
    db.prepare(`
      UPDATE sessions 
      SET status = 'alive', last_heartbeat = ?, client_type = ?, project_id = ?
      WHERE id = ?
    `).run(now, clientType, projectId, sessionId);
  } else {
    db.prepare(`
      INSERT INTO sessions (id, project_id, client_type, status, last_heartbeat, last_event_seen)
      VALUES (?, ?, ?, 'alive', ?, 0)
    `).run(sessionId, projectId, clientType, now);

    const event = appendEvent(projectId, sessionId, 'SESSION_CONNECTED', {
      session_id: sessionId,
      client_type: clientType,
      timestamp: now
    });

    db.prepare(`
      UPDATE sessions
      SET last_event_seen = ?
      WHERE id = ?
    `).run(event.id, sessionId);
  }

  return getSession(sessionId)!;
}

export function getSession(sessionId: string): SessionRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, project_id, client_type, status, last_heartbeat, last_event_seen
    FROM sessions 
    WHERE id = ?
  `).get(sessionId) as any;
  
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    client_type: row.client_type,
    status: row.status as any,
    last_heartbeat: Number(row.last_heartbeat),
    last_event_seen: Number(row.last_event_seen)
  };
}

export function getActiveSessions(projectId: string): SessionRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, client_type, status, last_heartbeat, last_event_seen
    FROM sessions
    WHERE project_id = ? AND status IN ('alive', 'stale')
  `).all(projectId) as any[];

  return rows.map(row => ({
    id: row.id,
    project_id: row.project_id,
    client_type: row.client_type,
    status: row.status as any,
    last_heartbeat: Number(row.last_heartbeat),
    last_event_seen: Number(row.last_event_seen)
  }));
}

export function processHeartbeat(projectId: string, sessionId: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  const sess = getSession(sessionId);
  if (!sess) {
    throw new McpError(ErrorCode.InvalidRequest, `Session ${sessionId} is not registered in project ${projectId}. Please call session.register first.`);
  }
  if (sess.project_id !== projectId) {
    throw new McpError(ErrorCode.InvalidRequest, `Session ${sessionId} is registered in project ${sess.project_id}, but request is for project ${projectId}.`);
  }

  db.prepare(`
    UPDATE sessions 
    SET status = 'alive', last_heartbeat = ?
    WHERE id = ?
  `).run(now, sessionId);
}

export function validateSession(projectId: string, sessionId: string): void {
  const sess = getSession(sessionId);
  if (!sess) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session ${sessionId} is not registered. Please call session.register first.`
    );
  }
  if (sess.project_id !== projectId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session ${sessionId} is registered under project ${sess.project_id}, but request is for project ${projectId}.`
    );
  }
  if (sess.status === 'dead') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Session ${sessionId} is dead. Please register a new session.`
    );
  }
}

export function updateLastEventSeen(sessionId: string, eventId: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions 
    SET last_event_seen = ?
    WHERE id = ?
  `).run(eventId, sessionId);
}

export function gracefulDisconnect(projectId: string, sessionId: string): void {
  validateSession(projectId, sessionId);
  
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  const handoff = generateStructuredHandoff(projectId, sessionId, 'graceful');

  const event = appendEvent(projectId, sessionId, 'SESSION_DISCONNECTED', {
    session_id: sessionId,
    timestamp: now,
    handoff: handoff
  });

  updateLastEventSeen(sessionId, event.id);
  
  db.prepare(`
    UPDATE sessions 
    SET status = 'dead', last_heartbeat = ?
    WHERE id = ?
  `).run(now, sessionId);
}

export function generateStructuredHandoff(
  projectId: string,
  sessionId: string,
  type: 'graceful' | 'ungraceful'
): Record<string, any> {
  const sess = getSession(sessionId);
  const sinceEventId = sess ? sess.last_event_seen : 0;

  // Fetch only events since last checkpoint for this session
  const sessionEvents = getSessionEvents(projectId, sessionId, sinceEventId);

  const completedTodos: string[] = [];
  const createdTodos: string[] = [];
  const rulesAdded: string[] = [];
  const decisionsRecorded: string[] = [];
  const wikiUpdated: string[] = [];

  for (const event of sessionEvents) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }

    switch (event.type) {
      case 'TODO_COMPLETED':
        completedTodos.push(`TODO ID ${payload.todo_id}`);
        break;
      case 'TODO_CREATED':
        createdTodos.push(`"${payload.title}" (ID ${payload.todo_id})`);
        break;
      case 'RULE_ADDED':
        rulesAdded.push(payload.content);
        break;
      case 'DECISION_RECORDED':
        decisionsRecorded.push(`"${payload.title}": ${payload.decision}`);
        break;
      case 'WIKI_UPDATED':
        wikiUpdated.push(payload.topic);
        break;
    }
  }

  const summary = type === 'graceful'
    ? `Graceful end of session for agent ${sessionId}.`
    : `Session ${sessionId} lost connection (missed heartbeat). Auto-generated continuity marker.`;

  return {
    session_id: sessionId,
    completed_todos: completedTodos,
    pending_todos: createdTodos,
    recent_decisions: decisionsRecorded,
    rules_added: rulesAdded,
    wiki_updated: wikiUpdated,
    summary,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

let lifecycleTimer: NodeJS.Timeout | null = null;
let lastSnapshotTime: number = Math.floor(Date.now() / 1000);

export function startLifecycleMonitor(checkIntervalMs: number = 15000): void {
  if (lifecycleTimer) return;

  lifecycleTimer = setInterval(() => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    // 1. Sessions transitioning to STALE (60s)
    const staleRows = db.prepare(`
      SELECT id, project_id, client_type, status, last_heartbeat, last_event_seen 
      FROM sessions
      WHERE status = 'alive' AND (? - last_heartbeat) > 60
    `).all(now) as any[];

    const staleTransition = db.transaction(() => {
      for (const row of staleRows) {
        db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = ?`).run(row.id);
        appendEvent(row.project_id, row.id, 'SESSION_STALE', {
          session_id: row.id,
          timestamp: now
        });
      }
    });
    staleTransition();
    
    // Invalidate caches after transaction commits
    for (const row of staleRows) {
      invalidateProjectCache(row.project_id);
    }

    // 2. Sessions transitioning to DEAD (300s / 5m)
    const deadRows = db.prepare(`
      SELECT id, project_id, client_type, status, last_heartbeat, last_event_seen
      FROM sessions
      WHERE status = 'stale' AND (? - last_heartbeat) > 300
    `).all(now) as any[];

    const deadTransition = db.transaction(() => {
      for (const row of deadRows) {
        db.prepare(`UPDATE sessions SET status = 'dead' WHERE id = ?`).run(row.id);
        
        const handoff = generateStructuredHandoff(row.project_id, row.id, 'ungraceful');
        
        const event = appendEvent(row.project_id, row.id, 'SESSION_DISCONNECTED', {
          session_id: row.id,
          timestamp: now,
          reason: 'heartbeat_timeout',
          handoff
        });
        
        updateLastEventSeen(row.id, event.id);
      }
    });
    deadTransition();
    
    // Invalidate caches after transaction commits
    for (const row of deadRows) {
      invalidateProjectCache(row.project_id);
    }

    // 3. Periodic snapshot check: Trigger snapshot checkpoint every 30 minutes (1800s)
    if (now - lastSnapshotTime >= 1800) {
      lastSnapshotTime = now;
      try {
        const activeProjects = db.prepare('SELECT id FROM projects').all() as any[];
        for (const project of activeProjects) {
          // Triggers snapshot logic internally by calling materialized state builders
          materializeProject(project.id, true);
        }
      } catch (e) {
        console.error('Failed to execute scheduled 30-minute database snapshot checker:', e);
      }
    }
  }, checkIntervalMs);

  lifecycleTimer.unref();
}

export function stopLifecycleMonitor(): void {
  if (lifecycleTimer) {
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }
}
