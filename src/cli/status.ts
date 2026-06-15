#!/usr/bin/env node
/**
 * cli/status.ts — Phase 4.1
 *
 * Standalone CLI command: `butler status`
 *
 * Reads the local .butler/butler.db directly (no MCP server required) and
 * prints a human-readable project summary:
 *   - Active sessions (alive / stale)
 *   - Open TODOs with priority and claim status
 *   - Recent handoffs (last 3)
 *   - Last event timestamp
 *   - Pending broadcasts and unread messages
 *
 * Usage:
 *   npx tsx src/cli/status.ts [--project <id>] [--db <path>] [--json]
 *   node dist/cli/status.js   [--project <id>] [--db <path>] [--json]
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { formatAge, truncate } from '../lib/format.js';
import { now as getCurrentTimestamp } from '../constants.js';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { project?: string; db?: string; json: boolean; help: boolean } {
  const args: { project?: string; db?: string; json: boolean; help: boolean } = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' || argv[i] === '-p') args.project = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

const HELP = `
butler status — inspect local Butler state without an MCP server

Usage:
  butler status [options]

Options:
  --project, -p <id>   Project ID to inspect (omit to show all projects)
  --db <path>          Path to butler.db (default: .butler/butler.db)
  --json               Output raw JSON instead of formatted text
  --help,    -h        Show this help

Examples:
  butler status
  butler status --project my-repo
  butler status --json | jq .sessions
`.trim();

// ─── DB helpers (read-only, no Butler bootstrap) ──────────────────────────────

interface ProjectRow  { id: string; name: string; created_at: number }
interface SessionRow  { id: string; project_id: string; client_type: string; status: string; created_at: number; last_heartbeat: number }
interface EventRow    { id: number; project_id: string; session_id: string; type: string; payload: string; created_at: number }
interface SnapshotRow { event_id: number; snapshot_json: string; sha256_hex: string; created_at: number }

function openDb(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    console.error(`❌  Database not found: ${dbPath}`);
    console.error(`    Run Butler at least once to create it, or pass --db <path>.`);
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function getProjects(db: Database.Database, projectId?: string): ProjectRow[] {
  if (projectId) {
    return db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').all(projectId) as ProjectRow[];
  }
  return db.prepare('SELECT id, name, created_at FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
}

function getSessions(db: Database.Database, projectId: string): SessionRow[] {
  return db.prepare(
    `SELECT id, project_id, client_type, status, created_at, last_heartbeat
     FROM sessions WHERE project_id = ? ORDER BY last_heartbeat DESC`
  ).all(projectId) as SessionRow[];
}

function getLastEvent(db: Database.Database, projectId: string): EventRow | null {
  return (db.prepare(
    'SELECT id, project_id, session_id, type, payload, created_at FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 1'
  ).get(projectId) ?? null) as EventRow | null;
}

function getEventCount(db: Database.Database, projectId: string): number {
  return (db.prepare('SELECT COUNT(*) as c FROM events WHERE project_id = ?').get(projectId) as any).c;
}

function getLatestSnapshot(db: Database.Database, projectId: string): SnapshotRow | null {
  return (db.prepare(
    'SELECT event_id, snapshot_json, sha256_hex, created_at FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1'
  ).get(projectId) ?? null) as SnapshotRow | null;
}

function getRecentHandoffs(db: Database.Database, projectId: string, limit = 3): EventRow[] {
  return db.prepare(
    `SELECT id, project_id, session_id, type, payload, created_at
     FROM events WHERE project_id = ? AND type IN ('HANDOFF_CREATED','SESSION_DISCONNECTED')
     ORDER BY id DESC LIMIT ?`
  ).all(projectId, limit) as EventRow[];
}

// ─── State extraction from snapshot ──────────────────────────────────────────

interface TodoItem { id: number; title: string; priority: string; status: string; claimed_by?: string }
interface ProjectState {
  todos?: Record<number, TodoItem>;
  messages?: Array<{ from_session_id: string; to_session_id: string; content: string; sent_at: number }>;
  broadcasts?: Array<{ from_session_id: string; content: string; sent_at: number }>;
  conflicts?: Array<{ todo_id: number; conflict_type: string; detected_at: number }>;
}

function loadState(snapshot: SnapshotRow | null): ProjectState {
  if (!snapshot) return {};
  try {
    return JSON.parse(snapshot.snapshot_json) as ProjectState;
  } catch {
    return {};
  }
}

import { computeHandoffQualityScore } from '../coordinator/lifecycle.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const PRIORITY_ICON: Record<string, string> = { high: '🔴', medium: '🟡', low: '🔵' };

function relAge(unixSecs: number): string {
  return formatAge(getCurrentTimestamp() - unixSecs);
}


function drawHeaderBox(projectId: string, liveCount: number, staleCount: number) {
  const line1 = `🌐 Butler — ${projectId}`;
  let statusText = `${colors.green}🟢 HEALTHY${colors.reset}`;
  if (liveCount === 0 && staleCount > 0) {
    statusText = `${colors.yellow}🟡 STALE${colors.reset}`;
  } else if (liveCount === 0 && staleCount === 0) {
    statusText = `${colors.red}🔴 INACTIVE${colors.reset}`;
  }

  const liveTotal = liveCount + staleCount;
  const line2 = `${statusText}  |  ${liveTotal} live session${liveTotal !== 1 ? 's' : ''}`;
  
  const cleanLine1 = line1;
  const cleanLine2 = `${liveCount === 0 && staleCount > 0 ? '🟡 STALE' : liveCount === 0 ? '🔴 INACTIVE' : '🟢 HEALTHY'}  |  ${liveTotal} live session${liveTotal !== 1 ? 's' : ''}`;
  const contentWidth = Math.max(cleanLine1.length, cleanLine2.length) + 4; // padding
  
  const border = '═'.repeat(contentWidth);
  const padLine = (text: string, cleanLength: number) => {
    const spaces = ' '.repeat(contentWidth - cleanLength);
    return `║  ${text}${spaces}  ║`;
  };
  
  console.log(`╔${border}╗`);
  console.log(padLine(line1, cleanLine1.length));
  console.log(padLine(line2, cleanLine2.length));
  console.log(`╚${border}╝`);
}

function printProjectStatus(
  db: Database.Database,
  project: ProjectRow,
  nowTs: number
) {
  // ── Sessions ────────────────────────────────────────────────────────────────
  const sessions = getSessions(db, project.id);
  const active   = sessions.filter(s => s.status !== 'dead');
  const dead     = sessions.filter(s => s.status === 'dead');
  const liveCount = active.filter(s => s.status === 'alive').length;
  const staleCount = active.filter(s => s.status === 'stale').length;

  console.log('');
  drawHeaderBox(project.id, liveCount, staleCount);

  console.log(`\n${colors.bold}SESSIONS${colors.reset}`);
  if (active.length === 0) {
    console.log('  No active sessions');
  } else {
    for (const s of active) {
      const age  = formatAge(nowTs - s.last_heartbeat) + ' ago';
      const icon = s.status === 'alive' ? `${colors.green}🟢${colors.reset}` : `${colors.yellow}🟡${colors.reset}`;
      const name = s.id.padEnd(20);
      const status = s.status.padEnd(8);
      console.log(`  ${icon} ${name} ${status} ${age}`);
    }
  }
  if (dead.length > 0) {
    console.log(`  ${colors.gray}⚫  ${dead.length} dead session(s) hidden${colors.reset}`);
  }

  // ── TODOs ───────────────────────────────────────────────────────────────────
  const snapshot = getLatestSnapshot(db, project.id);
  const state    = loadState(snapshot);
  const todos    = Object.values(state.todos ?? {});
  const pending  = todos.filter(t => t.status === 'pending');
  const done     = todos.filter(t => t.status === 'completed');

  console.log(`\n${colors.bold}TODOS (${pending.length} open, ${done.length} completed)${colors.reset}`);
  if (pending.length === 0) {
    console.log('  No open TODOs');
  } else {
    const sorted = pending.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority as keyof typeof order] ?? 1) - (order[b.priority as keyof typeof order] ?? 1);
    });
    for (const t of sorted.slice(0, 10)) {
      const claim  = t.claimed_by ? `  ${colors.blue}🔒 ${t.claimed_by}${colors.reset}` : '  (unclaimed)';
      const pIcon  = PRIORITY_ICON[t.priority] ?? '⚪';
      const pLabel = t.priority === 'high' ? '[high]' : t.priority === 'medium' ? '[med] ' : '[low] ';
      const pColor = t.priority === 'high' ? colors.red : t.priority === 'medium' ? colors.yellow : colors.blue;
      const id = `#${t.id}`.padEnd(5);
      console.log(`  ${pIcon} ${pColor}${pLabel}${colors.reset} ${id} ${truncate(t.title, 40).padEnd(40)} ${claim}`);
    }
    if (pending.length > 10) {
      console.log(`  … and ${pending.length - 10} more`);
    }
  }

  // ── Conflicts ───────────────────────────────────────────────────────────────
  const conflicts = state.conflicts ?? [];
  if (conflicts.length > 0) {
    console.log(`\n${colors.bold}${colors.red}⚠️  CONFLICTS (${conflicts.length} recent)${colors.reset}`);
    for (const c of conflicts.slice(0, 5)) {
      console.log(`  TODO #${c.todo_id}  ${c.conflict_type}  (${relAge(c.detected_at)})`);
    }
  }

  // ── Broadcasts ──────────────────────────────────────────────────────────────
  const broadcasts = state.broadcasts ?? [];
  if (broadcasts.length > 0) {
    console.log(`\n${colors.bold}📢  BROADCASTS (${broadcasts.length} recent)${colors.reset}`);
    for (const b of broadcasts.slice(-3)) {
      console.log(`  ${relAge(b.sent_at)}  [${colors.cyan}${b.from_session_id}${colors.reset}]: ${truncate(b.content, 70)}`);
    }
  }

  // ── Recent handoffs ─────────────────────────────────────────────────────────
  const handoffEvents = getRecentHandoffs(db, project.id);
  if (handoffEvents.length > 0) {
    console.log(`\n${colors.bold}🤝  RECENT HANDOFFS (last 3)${colors.reset}`);
    for (const ev of handoffEvents) {
      let payload: any = {};
      try { payload = JSON.parse(ev.payload); } catch {}
      const handoff = ev.type === 'HANDOFF_CREATED' ? payload : payload.handoff;
      const summary = handoff?.summary ? truncate(handoff.summary, 72) : '(no summary)';
      const src     = ev.type === 'HANDOFF_CREATED' ? 'agent' : 'system';
      console.log(`  [${src}]  ${colors.cyan}${ev.session_id}${colors.reset}  (${relAge(ev.created_at)})`);
      console.log(`          ${colors.gray}"${summary}"${colors.reset}`);
    }
  }

  // ── Handoff Quality Score ───────────────────────────────────────────────────
  if (handoffEvents.length > 0) {
    const ev = handoffEvents[0];
    let payload: any = {};
    try { payload = JSON.parse(ev.payload); } catch {}
    const handoff = ev.type === 'HANDOFF_CREATED' ? payload : payload.handoff;
    const summary = handoff?.summary || '';
    if (summary) {
      const score = computeHandoffQualityScore(summary);
      const scorePercent = Math.round(score * 100);
      const barLength = 10;
      const filledLength = Math.round(score * barLength);
      const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
      console.log(`\n${colors.bold}HANDOFF QUALITY SCORE  ${colors.green}${bar}${colors.reset}  ${scorePercent}% (last: ${ev.session_id})${colors.reset}`);
    }
  }

  // ── Event log stats ─────────────────────────────────────────────────────────
  const lastEvent  = getLastEvent(db, project.id);
  const eventCount = getEventCount(db, project.id);
  const snapInfo   = snapshot
    ? `snapshot @ event #${snapshot.event_id}  (${relAge(snapshot.created_at)})`
    : 'no snapshot yet';

  console.log(`\n${colors.gray}Event log: ${eventCount} events | last: ${lastEvent ? relAge(lastEvent.created_at) : 'never'}`);
  console.log(`Snapshot:  ${snapInfo}${colors.reset}`);
}

// ─── JSON output ──────────────────────────────────────────────────────────────

function buildJsonOutput(db: Database.Database, projects: ProjectRow[], nowTs: number) {
  return projects.map(project => {
    const sessions    = getSessions(db, project.id);
    const snapshot    = getLatestSnapshot(db, project.id);
    const state       = loadState(snapshot);
    const todos       = Object.values(state.todos ?? {});
    const lastEvent   = getLastEvent(db, project.id);
    const eventCount  = getEventCount(db, project.id);
    const handoffs    = getRecentHandoffs(db, project.id);

    return {
      project_id:   project.id,
      sessions:     sessions.map(s => ({ ...s, age_secs: nowTs - s.last_heartbeat })),
      todos: {
        pending:    todos.filter(t => t.status === 'pending'),
        completed:  todos.filter(t => t.status === 'completed').length
      },
      conflicts:    state.conflicts ?? [],
      broadcasts:   state.broadcasts ?? [],
      handoffs:     handoffs.map(ev => {
        let payload: any = {};
        try { payload = JSON.parse(ev.payload); } catch {}
        return { session_id: ev.session_id, type: ev.type, created_at: ev.created_at, payload };
      }),
      event_log: {
        total:      eventCount,
        last_event: lastEvent ? { id: lastEvent.id, type: lastEvent.type, created_at: lastEvent.created_at } : null
      },
      snapshot:     snapshot ? { event_id: snapshot.event_id, created_at: snapshot.created_at } : null
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const dbPath = args.db
    ? path.resolve(process.cwd(), args.db)
    : path.join(process.cwd(), '.butler', 'butler.db');

  const db     = openDb(dbPath);
  const nowTs  = getCurrentTimestamp();
  const projects = getProjects(db, args.project);

  if (projects.length === 0) {
    if (args.project) {
      console.error(`❌  Project "${args.project}" not found in ${dbPath}`);
    } else {
      console.log('No projects found. Butler has not been used in this directory yet.');
    }
    db.close();
    process.exit(args.project ? 1 : 0);
  }

  if (args.json) {
    console.log(JSON.stringify(buildJsonOutput(db, projects, nowTs), null, 2));
    db.close();
    return;
  }

  console.log(`\n🤵  Butler Status   ${new Date().toLocaleString()}`);
  console.log(`    Database: ${dbPath}`);
  console.log(`    Projects: ${projects.length}`);

  for (const project of projects) {
    printProjectStatus(db, project, nowTs);
  }

  console.log('\n');
  db.close();
}

main();
