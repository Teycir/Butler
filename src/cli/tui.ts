#!/usr/bin/env node
/**
 * cli/tui.ts
 *
 * Interactive TUI CLI for Butler: `butler tui`
 * Driver module that queries the SQLite database and passes state to tuiRenderer.js.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { now as getCurrentTimestamp } from '../constants.js';
import { generateDashboardString } from './tuiRenderer.js';
import {
  c,
  type ProjectRow,
  type SessionRow,
  type EventRow,
  type SnapshotRow,
  type ProjectState
} from './tuiTheme.js';

interface TuiState {
  currentProjectIndex: number;
  projectCount: number;
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { project?: string; db?: string } {
  const args: { project?: string; db?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' || argv[i] === '-p') args.project = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
  }
  return args;
}

// ─── Database read helpers ──────────────────────────────────────────────────

function openDb(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: any) {
    console.error('[Butler] Failed to open database:', err.message);
    return null;
  }
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
  const row = db.prepare('SELECT COUNT(*) as c FROM events WHERE project_id = ?').get(projectId) as { c: number } | undefined;
  return row ? row.c : 0;
}

function getLatestSnapshot(db: Database.Database, projectId: string): SnapshotRow | null {
  return (db.prepare(
    'SELECT event_id, snapshot_json, sha256_hex, created_at FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1'
  ).get(projectId) ?? null) as SnapshotRow | null;
}

function getRecentHandoffs(db: Database.Database, projectId: string, limit = 2): EventRow[] {
  return db.prepare(
    `SELECT id, project_id, session_id, type, payload, created_at
     FROM events WHERE project_id = ? AND type IN ('HANDOFF_CREATED','SESSION_DISCONNECTED')
     ORDER BY id DESC LIMIT ?`
  ).all(projectId, limit) as EventRow[];
}

function getDbSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as max_v FROM butler_migrations').get() as { max_v: number } | undefined;
    return row ? Number(row.max_v) : 0;
  } catch {
    return 0;
  }
}

function getProjectCount(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number } | undefined;
    return row ? row.c : 0;
  } catch {
    return 0;
  }
}

function loadState(snapshot: SnapshotRow | null): ProjectState {
  if (!snapshot) return {};
  try {
    return JSON.parse(snapshot.snapshot_json) as ProjectState;
  } catch (err) {
    console.error('[Butler] Failed to parse snapshot JSON in TUI:', err);
    return {};
  }
}

// ─── Render loop ─────────────────────────────────────────────────────────────

function renderDashboard(dbPath: string, tuiState: TuiState, argsProject?: string) {
  // Terminal size guard
  if (process.stdout.columns && process.stdout.columns < 100) {
    process.stdout.write(c.cls);
    console.log(`⚠️  Terminal is too narrow: ${process.stdout.columns} cols (minimum required: 100).`);
    console.log(`   Please resize your terminal window to see the dashboard.`);
    return;
  }

  const db = openDb(dbPath);
  const nowTs = getCurrentTimestamp();

  if (!db) {
    process.stdout.write(c.cls);
    console.log(`❌  Database not found: ${dbPath}`);
    console.log(`    Ensure Butler is running, or verify the DB path.`);
    return;
  }

  const projects = getProjects(db, argsProject);
  tuiState.projectCount = projects.length;
  if (tuiState.projectCount === 0) {
    process.stdout.write(c.cls);
    console.log(`❌  No projects found in database.`);
    db.close();
    return;
  }

  // Bound check selected project index
  if (tuiState.currentProjectIndex >= tuiState.projectCount) {
    tuiState.currentProjectIndex = 0;
  } else if (tuiState.currentProjectIndex < 0) {
    tuiState.currentProjectIndex = tuiState.projectCount - 1;
  }

  const project = projects[tuiState.currentProjectIndex];
  const sessions = getSessions(db, project.id);
  const snapshot = getLatestSnapshot(db, project.id);
  const state = loadState(snapshot);
  const eventCount = getEventCount(db, project.id);
  const lastEvent = getLastEvent(db, project.id);
  // Fetch limit matches the renderer layout capability exactly
  const recentHandoffs = getRecentHandoffs(db, project.id, 2);
  const schemaVersion = getDbSchemaVersion(db);
  const dbProjectCount = getProjectCount(db);

  let dbSizeKb = 0;
  try {
    const stats = fs.statSync(dbPath);
    dbSizeKb = Math.round(stats.size / 1024);
  } catch {
    // Ignore stat failures
  }

  const projectIndexInfo = tuiState.projectCount > 1
    ? `${tuiState.currentProjectIndex + 1}/${tuiState.projectCount}`
    : undefined;

  const outputStr = generateDashboardString(
    dbPath,
    project,
    sessions,
    state,
    eventCount,
    lastEvent,
    recentHandoffs,
    nowTs,
    dbSizeKb,
    dbProjectCount,
    schemaVersion,
    projectIndexInfo
  );

  // Clear and print screen
  process.stdout.write(c.cls + outputStr + '\n');
  db.close();
}

// ─── CLI Entry ───────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db
    ? path.resolve(process.cwd(), args.db)
    : path.join(process.cwd(), '.butler', 'butler.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`❌  Database not found: ${dbPath}`);
    console.error(`    Please run Butler at least once or specify --db.`);
    process.exit(1);
  }

  // Set stdin raw mode for key handling
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdout.write(c.hideCursor); // Hide cursor

  const tuiState: TuiState = {
    currentProjectIndex: 0,
    projectCount: 0
  };

  renderDashboard(dbPath, tuiState, args.project);

  const interval = setInterval(() => {
    renderDashboard(dbPath, tuiState, args.project);
  }, 2000);

  process.stdin.on('keypress', (_, key) => {
    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      clearInterval(interval);
      process.stdout.write(c.showCursor + c.reset); // Restore cursor and reset formatting
      process.exit(0);
    }
    if (key.name === 'r') {
      renderDashboard(dbPath, tuiState, args.project);
    }
    if (key.name === 'left' && tuiState.projectCount > 1) {
      tuiState.currentProjectIndex = (tuiState.currentProjectIndex - 1 + tuiState.projectCount) % tuiState.projectCount;
      renderDashboard(dbPath, tuiState, args.project);
    }
    if (key.name === 'right' && tuiState.projectCount > 1) {
      tuiState.currentProjectIndex = (tuiState.currentProjectIndex + 1) % tuiState.projectCount;
      renderDashboard(dbPath, tuiState, args.project);
    }
  });

  process.on('SIGINT', () => {
    clearInterval(interval);
    process.stdout.write(c.showCursor + c.reset);
    process.exit(0);
  });
}

main();
