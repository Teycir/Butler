import { getDb, sha256hex } from '../db/database.js';
import { EventPayloadMap, EventRecord, EventType } from './types.js';
import { now as getCurrentTimestamp, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_RETENTION_COUNT } from '../constants.js';

export function appendEvent<T extends EventType>(
  projectId: string,
  sessionId: string,
  type: T,
  payload: EventPayloadMap[T]
): EventRecord {
  const db = getDb();
  const payloadStr = JSON.stringify(payload);
  const now = getCurrentTimestamp();

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
  
  const execute = () => {
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
  };

  // If already in an active transaction, run the queries directly.
  // better-sqlite3 does support nested transactions via savepoints, but running 
  // directly avoids unnecessary savepoint overhead and nested transaction concerns.
  if (db.inTransaction) {
    return execute();
  }
  
  const incrementTx = db.transaction(execute);
  return incrementTx();
}

export function createSnapshot(projectId: string, eventId: number, state: Record<string, any>): void {
  const db = getDb();
  const now = getCurrentTimestamp();
  const stateStr = JSON.stringify(state);
  const checksum = sha256hex(stateStr);

  db.prepare(`
    INSERT INTO snapshots (project_id, event_id, snapshot_json, sha256_hex, schema_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, eventId, stateStr, checksum, SNAPSHOT_SCHEMA_VERSION, now);

  // Keep last N snapshots for recovery fallback
  db.prepare(`
    DELETE FROM snapshots 
    WHERE project_id = ? AND event_id NOT IN (
      SELECT event_id FROM snapshots 
      WHERE project_id = ? 
      ORDER BY event_id DESC 
      LIMIT ${SNAPSHOT_RETENTION_COUNT}
    )
  `).run(projectId, projectId);
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

  // Try snapshots newest-first; skip any that fail integrity or schema version checks
  const rows = db.prepare(`
    SELECT id, project_id, event_id, snapshot_json, sha256_hex, schema_version, created_at
    FROM snapshots
    WHERE project_id = ?
    ORDER BY event_id DESC
    LIMIT 3
  `).all(projectId) as any[];

  for (const row of rows) {
    // Schema version check: reject snapshots written by a different schema version
    const snapshotSchemaVersion = row.schema_version ?? 1;
    if (snapshotSchemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      console.error(
        `Snapshot schema version mismatch for project ${projectId} at event_id ${row.event_id} ` +
        `(snapshot: v${snapshotSchemaVersion}, current: v${SNAPSHOT_SCHEMA_VERSION}) — skipping`
      );
      continue;
    }

    // Integrity check: legacy snapshots (sha256_hex = '') are accepted without validation
    if (row.sha256_hex && row.sha256_hex !== '') {
      const expected = sha256hex(row.snapshot_json);
      if (expected !== row.sha256_hex) {
        console.error(
          `Snapshot integrity failure for project ${projectId} at event_id ${row.event_id} — skipping and replaying from prior snapshot`
        );
        continue;
      }
    }

    return {
      id: Number(row.id),
      project_id: row.project_id,
      event_id: Number(row.event_id),
      snapshot_json: row.snapshot_json,
      created_at: Number(row.created_at)
    };
  }

  return null;
}
