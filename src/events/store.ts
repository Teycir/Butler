import { getDb, sha256hex } from '../db/database.js';
import { EventPayloadMap, EventRecord, EventType } from './types.js';
import { now as getCurrentTimestamp, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_RETENTION_COUNT } from '../constants.js';
import { parseEvents, parseSnapshot } from '../db/zod.js';

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
  
  const rows = stmt.all(projectId, sinceEventId);
  return parseEvents(rows) as EventRecord[];
}


export function getSessionEvents(projectId: string, sessionId: string, sinceEventId: number = 0): EventRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, project_id, session_id, type, payload, created_at
    FROM events
    WHERE project_id = ? AND session_id = ? AND id > ?
    ORDER BY id ASC
  `);
  
  const rows = stmt.all(projectId, sessionId, sinceEventId);
  return parseEvents(rows) as EventRecord[];
}

/**
 * Returns a transaction-safe, sequentially incrementing ID for a specific entity type within a project.
 * Uses a SAVEPOINT so the three statements (INSERT OR IGNORE → UPDATE → SELECT) are always atomic,
 * whether called standalone or nested inside an outer transaction. If the outer transaction rolls back,
 * the savepoint rolls back with it, preventing gaps in the sequence.
 */
export function getNextSequenceValue(projectId: string, name: string): number {
  const db = getDb();

  // Check if we're already inside a transaction by attempting a nested transaction
  const inTransaction = db.inTransaction;

  if (inTransaction) {
    // Use SAVEPOINT when nested inside an outer transaction
    db.prepare('SAVEPOINT seq_savepoint').run();
    try {
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

      db.prepare('RELEASE seq_savepoint').run();
      return Number(row.next_value);
    } catch (err) {
      db.prepare('ROLLBACK TO seq_savepoint').run();
      throw err;
    }
  } else {
    // Not in a transaction — execute directly
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
  }
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
      LIMIT ?
    )
  `).run(projectId, projectId, SNAPSHOT_RETENTION_COUNT);
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
  `).all(projectId);

  for (const row of rows) {
    const parsed = parseSnapshot(row);
    // Schema version check: reject snapshots written by a different schema version
    const snapshotSchemaVersion = parsed.schema_version ?? 1;
    if (snapshotSchemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      console.error(
        `Snapshot schema version mismatch for project ${projectId} at event_id ${parsed.event_id} ` +
        `(snapshot: v${snapshotSchemaVersion}, current: v${SNAPSHOT_SCHEMA_VERSION}) — skipping`
      );
      continue;
    }

    // Integrity check: legacy snapshots (sha256_hex = '') are accepted without validation
    if (parsed.sha256_hex && parsed.sha256_hex !== '') {
      const expected = sha256hex(parsed.snapshot_json);
      if (expected !== parsed.sha256_hex) {
        console.error(
          `Snapshot integrity failure for project ${projectId} at event_id ${parsed.event_id} — skipping and replaying from prior snapshot`
        );
        continue;
      }
    }

    return {
      id: parsed.id,
      project_id: parsed.project_id,
      event_id: parsed.event_id,
      snapshot_json: parsed.snapshot_json,
      created_at: parsed.created_at
    };
  }

  return null;
}
