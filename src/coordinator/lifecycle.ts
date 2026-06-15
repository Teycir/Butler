/**
 * coordinator/lifecycle.ts
 *
 * Session CRUD, heartbeat processing, and the background lifecycle monitor.
 * Phase 2 additions (handoff generation, diff, staleness) live in sibling files:
 *   - handoff.ts  — generateStructuredHandoff, computeHandoffQualityScore
 *   - diff.ts     — getProjectDiff, getContextStaleness
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db/database.js';
import { appendEvent } from '../events/store.js';
import { materializeProject, invalidateProjectCache } from '../events/materializer.js';
import { validateProjectId, validateSessionId } from '../validation.js';
import {
  SESSION_STALE_THRESHOLD_SECS,
  SESSION_DEAD_THRESHOLD_SECS,
  SNAPSHOT_CHECK_INTERVAL_SECS,
  now as getCurrentTimestamp
} from '../constants.js';
import { generateStructuredHandoff } from './handoff.js';
import { getSession, updateLastEventSeen } from './session.js';
import type { SessionRecord } from './session.js';

// Re-export so existing callers importing from 'lifecycle' are unaffected
export { getSession, updateLastEventSeen } from './session.js';
export type { SessionRecord } from './session.js';

// Re-export Phase 2 helpers so callers can import everything from 'lifecycle'
export { generateStructuredHandoff, computeHandoffQualityScore } from './handoff.js';
export { getProjectDiff, getContextStaleness } from './diff.js';
export type { DiffEntry, ContextStalenessInfo } from './diff.js';

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export function registerSession(
  projectId: string,
  sessionId: string,
  clientType: string
): SessionRecord {
  validateProjectId(projectId);
  validateSessionId(sessionId);

  const db = getDb();
  const now = getCurrentTimestamp();

  const registerTx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

    const existing = db.prepare(`
      SELECT id, project_id, client_type, status, created_at, last_heartbeat, last_event_seen
      FROM sessions WHERE id = ?
    `).get(sessionId) as any;

    if (existing) {
      const event = appendEvent(projectId, sessionId, 'SESSION_RECOVERED', {
        session_id: sessionId, client_type: clientType, timestamp: now
      });
      db.prepare(`
        UPDATE sessions
        SET status = 'alive', last_heartbeat = ?, client_type = ?, project_id = ?, last_event_seen = ?
        WHERE id = ?
      `).run(now, clientType, projectId, event.id, sessionId);
    } else {
      db.prepare(`
        INSERT INTO sessions (id, project_id, client_type, status, last_heartbeat, last_event_seen)
        VALUES (?, ?, ?, 'alive', ?, 0)
      `).run(sessionId, projectId, clientType, now);

      const event = appendEvent(projectId, sessionId, 'SESSION_CONNECTED', {
        session_id: sessionId, client_type: clientType, timestamp: now
      });
      db.prepare(`UPDATE sessions SET last_event_seen = ? WHERE id = ?`).run(event.id, sessionId);
    }
  });

  registerTx();
  return getSession(sessionId)!;
}

export function getActiveSessions(projectId: string): SessionRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, client_type, status, created_at, last_heartbeat, last_event_seen
    FROM sessions
    WHERE project_id = ? AND status IN ('alive', 'stale')
  `).all(projectId) as any[];

  return rows.map(row => ({
    id: row.id,
    project_id: row.project_id,
    client_type: row.client_type,
    status: row.status as any,
    created_at: Number(row.created_at),
    last_heartbeat: Number(row.last_heartbeat),
    last_event_seen: Number(row.last_event_seen)
  }));
}

export function processHeartbeat(projectId: string, sessionId: string): void {
  const sess = getSession(sessionId);
  if (!sess) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      JSON.stringify({
        error: 'session_not_found',
        message: `Session ${sessionId} is not registered in project ${projectId}.`,
        hint: 'Call sessionregister first, or check session_id spelling.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
  if (sess.project_id !== projectId) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      JSON.stringify({
        error: 'session_project_mismatch',
        message: `Session ${sessionId} is registered in project ${sess.project_id}, but request is for project ${projectId}.`,
        hint: 'Check that project_id is correct, or register session under this project.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
  getDb().prepare(`UPDATE sessions SET status = 'alive', last_heartbeat = ? WHERE id = ?`)
    .run(getCurrentTimestamp(), sessionId);
}

export function ensureSession(
  projectId: string,
  sessionId: string,
  clientType = 'unknown'
): { session: SessionRecord; wasAutoRegistered: boolean } {
  const existing = getSession(sessionId);
  if (existing && existing.project_id === projectId && existing.status !== 'dead') {
    return { session: existing, wasAutoRegistered: false };
  }
  return { session: registerSession(projectId, sessionId, clientType), wasAutoRegistered: true };
}

export function validateSession(projectId: string, sessionId: string): void {
  const sess = getSession(sessionId);
  if (!sess) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'session_not_found',
        message: `Session '${sessionId}' is not registered in project '${projectId}'.`,
        hint: 'Call sessionregister first, or check session_id spelling.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
  if (sess.project_id !== projectId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'session_project_mismatch',
        message: `Session '${sessionId}' is registered under project '${sess.project_id}', but request is for project '${projectId}'.`,
        hint: 'Check that project_id is correct, or register session under this project.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
  if (sess.status === 'dead') {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'session_dead',
        message: `Session '${sessionId}' is dead.`,
        hint: 'Please register a new session.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
}

export function gracefulDisconnect(projectId: string, sessionId: string): void {
  validateSession(projectId, sessionId);

  const db = getDb();
  const now = getCurrentTimestamp();

  const handoff = generateStructuredHandoff(projectId, sessionId, 'graceful');
  const disconnectTx = db.transaction(() => {
    const event = appendEvent(projectId, sessionId, 'SESSION_DISCONNECTED', {
      session_id: sessionId,
      timestamp: now,
      handoff
    });
    updateLastEventSeen(sessionId, event.id);
    db.prepare(`UPDATE sessions SET status = 'dead', last_heartbeat = ? WHERE id = ?`)
      .run(now, sessionId);
  });

  disconnectTx();
  invalidateProjectCache(projectId);
}

// ─── Lifecycle Monitor ────────────────────────────────────────────────────────

let lifecycleTimer: NodeJS.Timeout | null = null;

export function startLifecycleMonitor(checkIntervalMs = 15000): void {
  if (lifecycleTimer) return;

  let lastSnapshotTime = getCurrentTimestamp();

  lifecycleTimer = setInterval(() => {
    const db = getDb();
    const now = getCurrentTimestamp();

    // 1. alive → stale (missed heartbeat, but not yet dead)
    const staleRows = db.prepare(`
      SELECT id, project_id FROM sessions
      WHERE status = 'alive'
        AND (? - last_heartbeat) > ?
        AND (? - last_heartbeat) <= ?
    `).all(now, SESSION_STALE_THRESHOLD_SECS, now, SESSION_DEAD_THRESHOLD_SECS) as any[];

    db.transaction(() => {
      for (const row of staleRows) {
        db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = ?`).run(row.id);
        appendEvent(row.project_id, row.id, 'SESSION_STALE', { session_id: row.id, timestamp: now });
      }
    })();
    const projectsToInvalidateStale = new Set<string>();
    for (const row of staleRows) projectsToInvalidateStale.add(row.project_id);
    for (const pid of projectsToInvalidateStale) invalidateProjectCache(pid);

    // 2. alive|stale → dead (heartbeat timeout exceeded)
    const deadRows = db.prepare(`
      SELECT id, project_id FROM sessions
      WHERE status IN ('alive', 'stale') AND (? - last_heartbeat) > ?
    `).all(now, SESSION_DEAD_THRESHOLD_SECS) as any[];

    // Pre-compute handoffs outside database transaction block
    const deadHandoffs = deadRows.map(row => ({
      row,
      handoff: generateStructuredHandoff(row.project_id, row.id, 'ungraceful')
    }));

    db.transaction(() => {
      for (const entry of deadHandoffs) {
        db.prepare(`UPDATE sessions SET status = 'dead' WHERE id = ?`).run(entry.row.id);
        const event = appendEvent(entry.row.project_id, entry.row.id, 'SESSION_DISCONNECTED', {
          session_id: entry.row.id, timestamp: now, reason: 'heartbeat_timeout', handoff: entry.handoff
        });
        updateLastEventSeen(entry.row.id, event.id);
      }
    })();
    const projectsToInvalidateDead = new Set<string>();
    for (const row of deadRows) projectsToInvalidateDead.add(row.project_id);
    for (const pid of projectsToInvalidateDead) invalidateProjectCache(pid);

    // 3. Periodic snapshot check
    if (now - lastSnapshotTime >= SNAPSHOT_CHECK_INTERVAL_SECS) {
      lastSnapshotTime = now;
      try {
        const projects = db.prepare('SELECT id FROM projects').all() as any[];
        for (const p of projects) materializeProject(p.id, true);
      } catch (e) {
        console.error('[Butler] Scheduled snapshot check failed:', e);
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
