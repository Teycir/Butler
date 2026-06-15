/**
 * cli/dashboardHandlers.ts
 *
 * Database query handlers and state serialization for the Butler web dashboard.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { formatAge } from '../lib/format.js';

export function openDb(dbPath: string, isDev = false): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: !isDev });
}

export function queryAll<T>(db: Database.Database, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function queryOne<T>(db: Database.Database, sql: string, ...params: any[]): T | null {
  return (db.prepare(sql).get(...params) ?? null) as T | null;
}

export function collectSnapshot(db: Database.Database, projectId: string) {
  const row = queryOne<{ snapshot_json: string; event_id: number }>(
    db, 'SELECT snapshot_json, event_id FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1', projectId
  );
  if (!row) return null;
  try {
    return { data: JSON.parse(row.snapshot_json) as any, event_id: row.event_id };
  } catch (err) {
    console.error(`[Butler] Failed to parse snapshot JSON for event ID ${row.event_id}:`, err);
    return null;
  }
}

export function buildDashboardData(db: Database.Database, nowTs: number) {
  const projects = queryAll<{ id: string; name: string; created_at: number }>(
    db, 'SELECT id, name, created_at FROM projects ORDER BY created_at DESC'
  );

  return projects.map(proj => {
    const sessions = queryAll<any>(
      db, `SELECT id, client_type, status, last_heartbeat, created_at FROM sessions
           WHERE project_id = ? ORDER BY last_heartbeat DESC`, proj.id
    );

    const snap     = collectSnapshot(db, proj.id);
    const state    = snap?.data ?? {};
    const todos    = Object.values((state.todos ?? {}) as Record<string, any>);
    const pending  = todos.filter((t: any) => t.status === 'pending');
    const done     = todos.filter((t: any) => t.status === 'completed');

    const recentEvents = queryAll<any>(
      db, `SELECT id, session_id, type, payload, created_at FROM events
           WHERE project_id = ? ORDER BY id DESC LIMIT 30`, proj.id
    );
    const eventCount = (queryOne<any>(db, 'SELECT COUNT(*) as c FROM events WHERE project_id = ?', proj.id) as any)?.c ?? 0;
    const lastEventAt = recentEvents[0]?.created_at ?? null;

    return {
      id: proj.id,
      sessions: sessions.map(s => ({
        ...s,
        age_secs: nowTs - s.last_heartbeat,
        age_label: formatAge(nowTs - s.last_heartbeat)
      })),
      todos: { pending, done_count: done.length },
      broadcasts: (state.broadcasts ?? []).slice(-5),
      messages:   (state.messages   ?? []).slice(-5),
      conflicts:  (state.conflicts  ?? []).slice(-10),
      events: recentEvents.map(ev => {
        let payload: any = {};
        try {
          payload = JSON.parse(ev.payload);
        } catch (err) {
          console.error(`[Butler] Failed to parse event payload for event ID ${ev.id}:`, err);
        }
        return { ...ev, payload };
      }),
      stats: { event_count: eventCount, last_event_at: lastEventAt, snapshot_event_id: snap?.event_id ?? null }
    };
  });
}
