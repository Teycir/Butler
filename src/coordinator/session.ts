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
import { parseSession } from '../db/zod.js';

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
  `).get(sessionId);

  if (!row) return null;
  return parseSession(row);
}

export function updateLastEventSeen(sessionId: string, eventId: number): void {
  getDb().prepare(`UPDATE sessions SET last_event_seen = ? WHERE id = ?`).run(eventId, sessionId);
}
