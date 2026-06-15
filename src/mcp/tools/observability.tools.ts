/**
 * mcp/tools/observability.tools.ts — Phase 4.3
 *
 * MCP tool definitions and handlers for developer observability:
 *   eventsexport  (4.3) — export the raw event log as JSON or NDJSON
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getDb, getDatabasePath } from '../../db/database.js';
import fs from 'fs';

const SERVER_START_TIME = Math.floor(Date.now() / 1000);

export const observabilityToolDefs = [
  {
    name: 'eventsexport',
    description:
      'Export the raw event log for a project as JSON or NDJSON. ' +
      'Useful for auditing, migration, or feeding events to external tooling. ' +
      'Pairs with snapshot import for full backup/restore flows.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project to export events from'
        },
        since: {
          type: 'number',
          description: 'Export only events with id > this value (inclusive of next). Omit for all events.'
        },
        until: {
          type: 'number',
          description: 'Export only events with id <= this value. Omit for all events up to latest.'
        },
        session_id: {
          type: 'string',
          description: 'Filter to events from a specific session (optional).'
        },
        event_type: {
          type: 'string',
          description: 'Filter to a specific event type, e.g. "TODO_CREATED" (optional).'
        },
        format: {
          type: 'string',
          enum: ['json', 'ndjson'],
          description: 'Output format. "json" returns a JSON array; "ndjson" returns newline-delimited JSON records. Default: json.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default 500, max 5000).'
        }
      },
      required: ['project_id']
    }
  },
  {
    name: 'butlerping',
    description: 'Lightweight diagnostic health-check to verify Butler is running and inspect database status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
] as const;

export async function handleObservabilityTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  if (name === 'butlerping') {
    const db = getDb();
    const dbPath = getDatabasePath();
    let db_size_kb = 0;
    try {
      const stats = fs.statSync(dbPath);
      db_size_kb = Math.round(stats.size / 1024);
    } catch {}

    let schema_version = 0;
    try {
      const migRow = db.prepare('SELECT MAX(version) as max_v FROM butler_migrations').get() as any;
      if (migRow) schema_version = Number(migRow.max_v);
    } catch {}

    let project_count = 0;
    try {
      const projRow = db.prepare('SELECT COUNT(*) as c FROM projects').get() as any;
      if (projRow) project_count = Number(projRow.c);
    } catch {}

    const uptime_seconds = Math.floor(Date.now() / 1000) - SERVER_START_TIME;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          db_path: dbPath,
          db_size_kb,
          schema_version,
          project_count,
          uptime_seconds
        }, null, 2)
      }]
    };
  }

  if (name !== 'eventsexport') {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown observability tool: ${name}`);
  }

  const format: 'json' | 'ndjson' = args.format === 'ndjson' ? 'ndjson' : 'json';
  const limit   = Math.min(Number(args.limit ?? 500), 5000);
  const since   = args.since  != null ? Number(args.since)  : null;
  const until   = args.until  != null ? Number(args.until)  : null;
  const sessFilter = args.session_id  ? String(args.session_id)  : null;
  const typeFilter = args.event_type  ? String(args.event_type)  : null;

  if (limit < 1) {
    throw new McpError(ErrorCode.InvalidParams, 'limit must be at least 1');
  }

  // Build query dynamically
  const conditions: string[] = ['project_id = ?'];
  const bindings: any[]      = [projectId];

  if (since != null) { conditions.push('id > ?');          bindings.push(since); }
  if (until != null) { conditions.push('id <= ?');         bindings.push(until); }
  if (sessFilter)    { conditions.push('session_id = ?');  bindings.push(sessFilter); }
  if (typeFilter)    { conditions.push('type = ?');        bindings.push(typeFilter); }

  bindings.push(limit);

  const sql = `
    SELECT id, session_id, type, payload, created_at
    FROM events
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
    LIMIT ?
  `;

  const rows = getDb().prepare(sql).all(...bindings) as Array<{
    id: number; session_id: string; type: string; payload: string; created_at: number
  }>;

  // Parse payload JSON for richer output; fall back to raw string on error
  const events = rows.map(row => {
    let payload: any;
    try { payload = JSON.parse(row.payload); }
    catch { payload = row.payload; }
    return {
      id:         row.id,
      project_id: projectId,
      session_id: row.session_id,
      type:       row.type,
      payload,
      created_at: row.created_at
    };
  });

  let output: string;
  if (format === 'ndjson') {
    output = events.map(ev => JSON.stringify(ev)).join('\n');
  } else {
    output = JSON.stringify({ project_id: projectId, count: events.length, events }, null, 2);
  }

  const filterSummary = [
    since   != null ? `since #${since}`        : null,
    until   != null ? `until #${until}`        : null,
    sessFilter      ? `session=${sessFilter}`  : null,
    typeFilter      ? `type=${typeFilter}`     : null,
  ].filter(Boolean).join(', ');

  const header = `# Event export: project="${projectId}"  count=${events.length}  format=${format}${filterSummary ? `  filters=[${filterSummary}]` : ''}\n\n`;

  return {
    content: [{ type: 'text', text: header + output }]
  };
}
