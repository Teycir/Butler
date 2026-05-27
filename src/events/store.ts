import { getDb } from '../db/database.js';
import { EventRecord, EventType } from './types.js';

export function appendEvent(
  projectId: string,
  sessionId: string,
  type: EventType,
  payload: Record<string, any>
): EventRecord {
  const db = getDb();
  const payloadStr = JSON.stringify(payload);
  const now = Math.floor(Date.now() / 1000);

  const result = db.prepare(`
    INSERT INTO events (project_id, session_id, type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, sessionId, type, payloadStr, now);

  const eventId = Number(result.lastInsertRowid);

  return {
    id: eventId,
    project_id: projectId,
    session_id: sessionId,
    type,
    payload: payloadStr,
    created_at: now
  };
}

export function getEvents(projectId: string, sinceEventId: number = 0): EventRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, project_id, session_id, type, payload, created_at
    FROM events
    WHERE project_id = ? AND id > ?
    ORDER BY id ASC
  `);
  
  const rows = stmt.all(projectId, sinceEventId) as any[];
  return rows.map(r => ({
    id: Number(r.id),
    project_id: r.project_id,
    session_id: r.session_id,
    type: r.type as EventType,
    payload: r.payload,
    created_at: Number(r.created_at)
  }));
}

export function getSessionEvents(projectId: string, sessionId: string, sinceEventId: number = 0): EventRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, project_id, session_id, type, payload, created_at
    FROM events
    WHERE project_id = ? AND session_id = ? AND id > ?
    ORDER BY id ASC
  `);
  
  const rows = stmt.all(projectId, sessionId, sinceEventId) as any[];
  return rows.map(r => ({
    id: Number(r.id),
    project_id: r.project_id,
    session_id: r.session_id,
    type: r.type as EventType,
    payload: r.payload,
    created_at: Number(r.created_at)
  }));
}

/**
 * Returns a transaction-safe, sequentially incrementing ID for a specific entity type within a project.
 * Uses atomic SQLite transactions to prevent race conditions on concurrent insertions.
 */
export function getNextSequenceValue(projectId: string, name: string): number {
  const db = getDb();
  
  const incrementTx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO sequences (project_id, name, next_value)
      VALUES (?, ?, 0)
    `).run(projectId, name);
    
    db.prepare(`
      UPDATE sequences
      SET next_value = next_value + 1
      WHERE project_id = ? AND name = ?
    `).run(projectId, name);
    
    const row = db.prepare(`
      SELECT next_value
      FROM sequences
      WHERE project_id = ? AND name = ?
    `).get(projectId, name) as any;
    
    return Number(row.next_value);
  });
  
  return incrementTx();
}

export function createSnapshot(projectId: string, eventId: number, state: Record<string, any>): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stateStr = JSON.stringify(state);

  db.prepare(`
    INSERT INTO snapshots (project_id, event_id, snapshot_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(projectId, eventId, stateStr, now);
}

export interface SnapshotRecord {
  id: number;
  project_id: string;
  event_id: number;
  snapshot_json: string;
  created_at: number;
}

export function getLatestSnapshot(projectId: string): SnapshotRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, project_id, event_id, snapshot_json, created_at
    FROM snapshots
    WHERE project_id = ?
    ORDER BY event_id DESC
    LIMIT 1
  `).get(projectId) as any;

  if (!row) return null;

  return {
    id: Number(row.id),
    project_id: row.project_id,
    event_id: Number(row.event_id),
    snapshot_json: row.snapshot_json,
    created_at: Number(row.created_at)
  };
}
