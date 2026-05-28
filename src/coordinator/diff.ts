/**
 * coordinator/diff.ts
 *
 * Phase 2.2 — Project event diff (changelog since a given event ID).
 * Phase 2.3 — Context staleness signals.
 *
 * Extracted from lifecycle.ts to keep each file focused on one concern.
 */

import { getDb } from '../db/database.js';
import { getEvents } from '../events/store.js';
import { now as getCurrentTimestamp } from '../constants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiffEntry {
  event_id: number;
  session_id: string;
  type: string;
  summary: string;
  timestamp: number;
}

export interface ContextStalenessInfo {
  /** Unix timestamp of the most recent alive heartbeat, or null if none. */
  last_live_heartbeat: number | null;
  /** Whether any session is currently alive. */
  has_live_session: boolean;
  /** Events appended since the caller's last_event_seen (0 if not provided). */
  events_since_last_read: number;
  /** Seconds elapsed since the last live heartbeat, or null. */
  context_age_seconds: number | null;
}

// ─── Phase 2.2 — Diff ────────────────────────────────────────────────────────

/**
 * Returns a flat, human-readable list of all meaningful state-changing events
 * since `sinceEventId`. Skips low-signal events (heartbeats, raw snapshots).
 */
export function getProjectDiff(projectId: string, sinceEventId: number): DiffEntry[] {
  const events = getEvents(projectId, sinceEventId);
  const entries: DiffEntry[] = [];

  for (const event of events) {
    let payload: any;
    try { payload = JSON.parse(event.payload); } catch { continue; }

    const summary = summariseEvent(event.type, event.session_id, payload);
    if (summary === null) continue; // skip non-state-changing events

    entries.push({
      event_id: event.id,
      session_id: event.session_id,
      type: event.type,
      summary,
      timestamp: event.created_at
    });
  }

  return entries;
}

function summariseEvent(type: string, sessionId: string, payload: any): string | null {
  switch (type) {
    case 'TODO_CREATED':
      return `TODO created: "${payload.title}" (ID ${payload.todo_id}, priority: ${payload.priority ?? 'medium'})`;
    case 'TODO_COMPLETED':
      return `TODO ${payload.todo_id} marked completed`;
    case 'TODO_UPDATED': {
      const parts: string[] = [];
      if (payload.title != null) parts.push(`title → "${payload.title}"`);
      if (payload.priority != null) parts.push(`priority → ${payload.priority}`);
      if (payload.status != null) parts.push(`status → ${payload.status}`);
      return `TODO ${payload.todo_id} updated: ${parts.join(', ')}`;
    }
    case 'TODO_DELETED':
      return `TODO ${payload.todo_id} deleted`;
    case 'WIKI_UPDATED':
      return `Wiki page updated: "${payload.topic}"`;
    case 'RULE_ADDED':
      return `Rule added: "${payload.content}"`;
    case 'RULE_REMOVED':
      return `Rule removed (ID: ${payload.rule_id})`;
    case 'DECISION_RECORDED':
      return `Decision recorded: "${payload.title}" — ${payload.decision}`;
    case 'HANDOFF_CREATED':
      return `Handoff from ${payload.session_id ?? sessionId}: ${payload.summary ?? ''}`;
    case 'SESSION_CONNECTED':
      return `Session connected: ${sessionId} (${payload.client_type})`;
    case 'SESSION_DISCONNECTED':
      return `Session disconnected: ${sessionId}`;
    case 'SESSION_STALE':
      return `Session went stale: ${sessionId}`;
    case 'SESSION_RECOVERED':
      return `Session recovered: ${sessionId}`;
    default:
      return null; // heartbeats, memory events, snapshots — skip
  }
}

// ─── Phase 2.3 — Staleness ───────────────────────────────────────────────────

/**
 * Returns freshness metadata for a project's context.
 * Pass `callerLastEventSeen` (from the raw context payload's `last_event_id`)
 * to get an accurate `events_since_last_read` count.
 */
export function getContextStaleness(
  projectId: string,
  callerLastEventSeen?: number
): ContextStalenessInfo {
  const db = getDb();
  const now = getCurrentTimestamp();

  const row = db.prepare(`
    SELECT MAX(last_heartbeat) as last_hb
    FROM sessions
    WHERE project_id = ? AND status = 'alive'
  `).get(projectId) as any;

  const lastLiveHeartbeat: number | null = row?.last_hb ? Number(row.last_hb) : null;

  let eventsSinceLastRead = 0;
  if (callerLastEventSeen != null && callerLastEventSeen > 0) {
    const countRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM events
      WHERE project_id = ? AND id > ?
    `).get(projectId, callerLastEventSeen) as any;
    eventsSinceLastRead = countRow ? Number(countRow.cnt) : 0;
  }

  return {
    last_live_heartbeat: lastLiveHeartbeat,
    has_live_session: lastLiveHeartbeat !== null,
    events_since_last_read: eventsSinceLastRead,
    context_age_seconds: lastLiveHeartbeat ? now - lastLiveHeartbeat : null
  };
}
