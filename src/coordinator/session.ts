/**
 * coordinator/session.ts
 *
 * Low-level session read helpers — no imports from lifecycle.ts or handoff.ts.
 * Exists to break the circular dependency:
 *   lifecycle.ts → handoff.ts → (formerly) lifecycle.ts
 *
 * Both lifecycle.ts and handoff.ts import from here instead.
 */

import { getDb } from '../db/database.js';

export interface SessionRecord {
  id: string;
  project_id: string;
  client_type: string;
  status: 'alive' | 'stale' | 'dead';
  created_at: number;
  last_heartbeat: number;
  last_event_seen: number;
}

export function getSession(sessionId: string): SessionRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, project_id, client_type, status, created_at, last_heartbeat, last_event_seen
    FROM sessions WHERE id = ?
  `).get(sessionId) as any;

  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    client_type: row.client_type,
    status: row.status as any,
    created_at: Number(row.created_at),
    last_heartbeat: Number(row.last_heartbeat),
    last_event_seen: Number(row.last_event_seen)
  };
}

export function updateLastEventSeen(sessionId: string, eventId: number): void {
  getDb().prepare(`UPDATE sessions SET last_event_seen = ? WHERE id = ?`).run(eventId, sessionId);
}
