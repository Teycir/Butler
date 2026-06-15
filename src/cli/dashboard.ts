/**
 * cli/dashboard.ts — Phase 4.2
 *
 * Local web dashboard served on http://localhost:7888
 *
 * Shows live project state, session heartbeat activity, open TODOs,
 * recent events, and coordination signals (broadcasts, messages, conflicts).
 *
 * Writable dev mode unlocked via --dev flag.
 * Auto-refreshes every 5 seconds via a lightweight SSE stream.
 *
 * Usage:
 *   npm run dashboard                   # serves localhost:7888
 *   npm run dashboard -- --port 8080
 *   npm run dashboard -- --db path/to/butler.db
 *   npm run dashboard -- --dev          # unlocks write operations
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { formatAge } from '../lib/format.js';
import { now as getCurrentTimestamp } from '../constants.js';
import { appendEvent } from '../events/store.js';
import { materializeProject, invalidateProjectCache } from '../events/materializer.js';
import { initDatabase } from '../db/database.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { port: number; db?: string; host: string; dev: boolean } {
  const args = { port: 7888, host: '127.0.0.1', db: undefined as string | undefined, dev: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') args.port = Number(argv[++i]);
    if (argv[i] === '--host') args.host = argv[++i];
    if (argv[i] === '--db') args.db = argv[++i];
    if (argv[i] === '--dev') args.dev = true;
  }
  return args;
}

// ─── DB read helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, isDev: boolean = false): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: !isDev });
}

function queryAll<T>(db: Database.Database, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T>(db: Database.Database, sql: string, ...params: any[]): T | null {
  return (db.prepare(sql).get(...params) ?? null) as T | null;
}

function collectSnapshot(db: Database.Database, projectId: string) {
  const row = queryOne<{ snapshot_json: string; event_id: number }>(
    db, 'SELECT snapshot_json, event_id FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1', projectId
  );
  if (!row) return null;
  try { return { data: JSON.parse(row.snapshot_json) as any, event_id: row.event_id }; }
  catch { return null; }
}

function buildDashboardData(db: Database.Database, nowTs: number) {
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
        try { payload = JSON.parse(ev.payload); } catch {}
        return { ...ev, payload };
      }),
      stats: { event_count: eventCount, last_event_at: lastEventAt, snapshot_event_id: snap?.event_id ?? null }
    };
  });
}

// ─── HTML template ────────────────────────────────────────────────────────────

function renderHtml(dbPath: string, isDev: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🤵 Butler Dashboard</title>
  <style>
    :root { --bg:#0f1117; --card:#1a1d27; --border:#2a2d3e; --text:#e2e8f0; --muted:#64748b;
            --green:#22c55e; --yellow:#eab308; --red:#ef4444; --blue:#3b82f6; --accent:#6366f1; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.6; }
    header { background: var(--card); border-bottom: 1px solid var(--border); padding: 12px 24px;
             display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 10; }
    header h1 { font-size: 16px; letter-spacing: 0.05em; }
    .badge { background: var(--accent); color: #fff; border-radius: 4px; padding: 2px 8px; font-size: 11px; }
    .badge.dev { background: var(--green); }
    .live { color: var(--green); font-size: 11px; }
    .db-path { color: var(--muted); font-size: 11px; flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    main { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .project { margin-bottom: 48px; }
    .project-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .project-header h2 { font-size: 15px; color: var(--accent); }
    .stats { color: var(--muted); font-size: 11px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; position: relative; }
    .card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 12px; }
    .session { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .session:last-child { border-bottom: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.alive { background: var(--green); }
    .dot.stale { background: var(--yellow); }
    .dot.dead  { background: var(--red); }
    .sess-id   { flex: 1; font-weight: 600; }
    .sess-meta { color: var(--muted); font-size: 11px; }
    .todo { padding: 6px 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    .todo:last-child { border-bottom: none; }
    .priority { font-size: 11px; width: 52px; flex-shrink: 0; }
    .priority.high   { color: var(--red); }
    .priority.medium { color: var(--yellow); }
    .priority.low    { color: var(--green); }
    .todo-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .claim { color: var(--blue); font-size: 11px; }
    .event { display: flex; gap: 8px; padding: 4px 0; font-size: 11px; border-bottom: 1px solid var(--border); }
    .event:last-child { border-bottom: none; }
    .event-type { color: var(--accent); width: 160px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .event-sess { color: var(--muted); width: 120px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .event-summary { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .event-age { color: var(--muted); flex-shrink: 0; }
    .broadcast { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
    .broadcast:last-child { border-bottom: none; }
    .conflict { color: var(--yellow); font-size: 12px; padding: 4px 0; }
    .empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
    .no-projects { text-align: center; padding: 80px 0; color: var(--muted); }
    .no-projects h2 { margin-bottom: 8px; font-size: 18px; color: var(--text); }
    
    /* Writable UI elements */
    .btn { background: none; border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer; font-family: inherit; transition: all 0.2s ease; }
    .btn-ok { color: var(--green); border-color: var(--green); }
    .btn-ok:hover { background: var(--green); color: #fff; }
    .btn-edit { color: var(--blue); border-color: var(--blue); }
    .btn-edit:hover { background: var(--blue); color: #fff; }
    .btn-delete { color: var(--red); border-color: var(--red); }
    .btn-delete:hover { background: var(--red); color: #fff; }
    
    .input-text { background: #0f1117; border: 1px solid var(--border); color: #fff; padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 11px; }
    .btn-submit { background: var(--accent); color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; transition: background 0.2s; }
    .btn-submit:hover { background: #5154e6; }
  </style>
</head>
<body>
<header>
  <h1>🤵 Butler Dashboard</h1>
  <span class="badge ${isDev ? 'dev' : ''}">${isDev ? 'dev-writable' : 'read-only'}</span>
  <span class="live" id="live">● live</span>
  <span class="db-path">${dbPath}</span>
</header>
<main id="main"><p class="no-projects"><h2>Loading…</h2></p></main>

<script>
const DEV_MODE = ${isDev ? 'true' : 'false'};
const NOW_OFFSET = Date.now();
function age(unixSecs) {
  const secs = Math.floor(Date.now()/1000) - unixSecs;
  if (secs < 60)   return secs + 's ago';
  if (secs < 3600) return Math.floor(secs/60) + 'm ago';
  return Math.floor(secs/3600) + 'h ago';
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0,n-1)+'…' : s; }

function eventSummary(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'TODO_CREATED':    return 'New: ' + trunc(p.title||'', 40);
    case 'TODO_COMPLETED':  return 'Done: TODO #' + p.todo_id;
    case 'TODO_UPDATED':    return 'Updated: TODO #' + p.todo_id;
    case 'TODO_DELETED':    return 'Deleted: TODO #' + p.todo_id;
    case 'TODO_CLAIMED':    return 'Claimed: TODO #' + p.todo_id;
    case 'TODO_UNCLAIMED':  return 'Unclaimed: TODO #' + p.todo_id;
    case 'TODO_CONFLICT':   return '⚠ Conflict on TODO #' + p.todo_id;
    case 'BROADCAST':       return '📢 ' + trunc(p.content||'', 50);
    case 'MESSAGE_SENT':    return '📬 → ' + p.to_session_id + ': ' + trunc(p.content||'', 35);
    case 'RULE_ADDED':      return '📌 ' + trunc(p.content||'', 45);
    case 'RULE_REMOVED':    return '❌ Rule removed';
    case 'WIKI_UPDATED':    return '📚 Wiki: ' + trunc(p.topic||'', 40);
    case 'DECISION_RECORDED': return '💡 ADR: ' + trunc(p.title||'', 40);
    case 'HANDOFF_CREATED': return '🤝 Handoff: ' + trunc(p.summary||'', 40);
    case 'SESSION_DISCONNECTED': return 'Disconnected';
    case 'SESSION_RECOVERED':    return 'Recovered';
    default: return ev.type;
  }
}

function completeTodo(projectId, todoId) {
  if (!confirm('Mark TODO #' + todoId + ' as completed?')) return;
  fetch('/api/projects/' + projectId + '/todos/' + todoId + '/complete', { method: 'POST' })
    .then(r => r.json())
    .then(res => { if (res.error) alert(res.message); });
}

function deleteTodo(projectId, todoId) {
  if (!confirm('Delete TODO #' + todoId + '? This cannot be undone.')) return;
  fetch('/api/projects/' + projectId + '/todos/' + todoId, { method: 'DELETE' })
    .then(r => r.json())
    .then(res => { if (res.error) alert(res.message); });
}

function editTodo(projectId, todoId, currentTitle) {
  const newTitle = prompt('Edit TODO #' + todoId + ' title:', currentTitle);
  if (newTitle === null) return;
  if (!newTitle.trim()) { alert('Title cannot be empty'); return; }
  fetch('/api/projects/' + projectId + '/todos/' + todoId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle })
  })
    .then(r => r.json())
    .then(res => { if (res.error) alert(res.message); });
}

function postBroadcast(event, projectId) {
  event.preventDefault();
  const form = event.target;
  const input = form.elements.content;
  const content = input.value;
  fetch('/api/projects/' + projectId + '/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content })
  })
    .then(r => r.json())
    .then(res => {
      if (res.error) {
        alert(res.message);
      } else {
        form.reset();
      }
    });
}

function renderProject(proj) {
  const pending = proj.todos.pending;
  const sessHtml = proj.sessions.length === 0
    ? '<div class="empty">No sessions</div>'
    : proj.sessions.map(s => \`
        <div class="session">
          <div class="dot \${esc(s.status)}"></div>
          <span class="sess-id">\${esc(s.id)}</span>
          <span class="sess-meta">\${esc(s.client_type)} · \${age(s.last_heartbeat)}</span>
        </div>\`).join('');

  const todoHtml = pending.length === 0
    ? '<div class="empty">No open TODOs</div>'
    : pending.sort((a,b) => ({high:0,medium:1,low:2}[a.priority]??1) - ({high:0,medium:1,low:2}[b.priority]??1))
        .slice(0, 15).map(t => {
          const devButtons = DEV_MODE ? \`
            <div style="display:inline-flex; gap:6px; margin-left:8px;">
              <button class="btn btn-ok" title="Complete TODO" onclick="completeTodo('\${proj.id}', \${t.id})">✓</button>
              <button class="btn btn-edit" title="Edit TODO Title" onclick="editTodo('\${proj.id}', \${t.id}, '\${esc(t.title)}')">✎</button>
              <button class="btn btn-delete" title="Delete TODO" onclick="deleteTodo('\${proj.id}', \${t.id})">✗</button>
            </div>\` : '';
          return \`
            <div class="todo">
              <span class="priority \${esc(t.priority)}">\${esc(t.priority)}</span>
              <span class="todo-title">[#\${t.id}] \${esc(trunc(t.title,45))}</span>
              \${t.claimed_by ? \`<span class="claim">→ \${esc(t.claimed_by)}</span>\` : ''}
              \${devButtons}
            </div>\`;
        }).join('');

  const bcHtml = proj.broadcasts.length === 0
    ? '<div class="empty">No recent broadcasts</div>'
    : [...proj.broadcasts].reverse().map(b => \`
        <div class="broadcast">
          <span style="color:var(--muted)">\${age(b.sent_at)}</span>
          <span style="color:var(--accent)"> [\${esc(b.from_session_id)}]</span>
          \${esc(trunc(b.content, 80))}
        </div>\`).join('');

  const devBroadcastForm = DEV_MODE ? \`
    <form onsubmit="postBroadcast(event, '\${proj.id}')" style="margin-top:12px; display:flex; gap:8px;">
      <input type="text" placeholder="Post broadcast..." name="content" required class="input-text" style="flex:1;">
      <button type="submit" class="btn-submit">Post</button>
    </form>\` : '';

  const confHtml = proj.conflicts.length === 0
    ? '<div class="empty">No recent conflicts</div>'
    : proj.conflicts.map(c => \`
        <div class="conflict">⚠ TODO #\${c.todo_id} — \${esc(c.conflict_type)} (\${age(c.detected_at)})</div>\`).join('');

  const evHtml = proj.events.length === 0
    ? '<div class="empty">No events</div>'
    : proj.events.map(ev => \`
        <div class="event">
          <span class="event-type">\${esc(ev.type)}</span>
          <span class="event-sess">\${esc(ev.session_id)}</span>
          <span class="event-summary">\${esc(eventSummary(ev))}</span>
          <span class="event-age">\${age(ev.created_at)}</span>
        </div>\`).join('');

  const snap = proj.stats.snapshot_event_id ? 'snapshot @ #' + proj.stats.snapshot_event_id : 'no snapshot';
  return \`
    <div class="project">
      <div class="project-header">
        <h2>📁 \${esc(proj.id)}</h2>
        <span class="stats">
          \${proj.sessions.filter(s=>s.status!=='dead').length} active sessions ·
          \${pending.length} open TODOs ·
          \${proj.stats.event_count} events ·
          \${snap}
        </span>
      </div>
      <div class="grid">
        <div class="card"><h3>Sessions</h3>\${sessHtml}</div>
        <div class="card"><h3>Open TODOs</h3>\${todoHtml}</div>
        <div class="card"><h3>Broadcasts</h3>\${bcHtml}\${devBroadcastForm}</div>
        <div class="card"><h3>Conflicts</h3>\${confHtml}</div>
        <div class="card" style="grid-column:1/-1"><h3>Event Log (last 30)</h3>\${evHtml}</div>
      </div>
    </div>\`;
}

function render(projects) {
  const main = document.getElementById('main');
  if (!projects || projects.length === 0) {
    main.innerHTML = \`<div class="no-projects"><h2>No projects yet</h2><p>Butler has not been used in this directory.</p></div>\`;
    return;
  }
  main.innerHTML = projects.map(renderProject).join('');
}

// SSE for live updates
const src = new EventSource('/events');
src.addEventListener('data', e => render(JSON.parse(e.data)));
src.onerror = () => { document.getElementById('live').textContent = '○ reconnecting…'; document.getElementById('live').style.color='var(--yellow)'; };
src.onopen  = () => { document.getElementById('live').textContent = '● live'; document.getElementById('live').style.color='var(--green)'; };

// Also do an immediate fetch on load
fetch('/api/data').then(r=>r.json()).then(render);
</script>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

// Tracks SSE clients for live-push
const sseClients = new Set<http.ServerResponse>();

function pushToClients(data: string) {
  for (const res of sseClients) {
    try { res.write(`event: data\ndata: ${data}\n\n`); }
    catch { sseClients.delete(res); }
  }
}

function createServer(dbPath: string, isDev: boolean): http.Server {
  const html = renderHtml(dbPath, isDev);

  return http.createServer((req, res) => {
    // ── POST /api/projects/:projectId/todos/:todoId/complete ────────────────
    const completeMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/todos\/([^/]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      if (!isDev) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Dashboard is in read-only mode' }));
        return;
      }
      const [, projectId, todoIdStr] = completeMatch;
      const todoId = Number(todoIdStr);
      try {
        const db = openDb(dbPath, true);
        if (!db) throw new Error('database not found');
        
        db.transaction(() => {
          const state = materializeProject(projectId, false);
          const todo = state.todos[todoId];
          if (!todo) throw new Error(`TODO ID ${todoId} not found`);
          if (todo.status === 'completed') throw new Error(`TODO ID ${todoId} already completed`);
          
          appendEvent(projectId, 'dashboard', 'TODO_COMPLETED', { todo_id: todoId, version: todo.version });
        })();
        
        invalidateProjectCache(projectId);
        db.close();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
        // Push update to clients
        const freshDb = openDb(dbPath, false);
        if (freshDb) {
          const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
          freshDb.close();
          pushToClients(JSON.stringify(freshData));
        }
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', message: e.message }));
      }
      return;
    }

    // ── DELETE /api/projects/:projectId/todos/:todoId ──────────────────────
    const deleteMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/todos\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      if (!isDev) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Dashboard is in read-only mode' }));
        return;
      }
      const [, projectId, todoIdStr] = deleteMatch;
      const todoId = Number(todoIdStr);
      try {
        const db = openDb(dbPath, true);
        if (!db) throw new Error('database not found');
        
        db.transaction(() => {
          const state = materializeProject(projectId, false);
          const todo = state.todos[todoId];
          if (!todo) throw new Error(`TODO ID ${todoId} not found`);
          
          appendEvent(projectId, 'dashboard', 'TODO_DELETED', { todo_id: todoId });
        })();
        
        invalidateProjectCache(projectId);
        db.close();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
        // Push update to clients
        const freshDb = openDb(dbPath, false);
        if (freshDb) {
          const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
          freshDb.close();
          pushToClients(JSON.stringify(freshData));
        }
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', message: e.message }));
      }
      return;
    }

    // ── PATCH /api/projects/:projectId/todos/:todoId ───────────────────────
    if (req.method === 'PATCH' && deleteMatch) {
      if (!isDev) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Dashboard is in read-only mode' }));
        return;
      }
      const [, projectId, todoIdStr] = deleteMatch;
      const todoId = Number(todoIdStr);
      
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const title = payload.title;
          if (!title || typeof title !== 'string' || title.trim() === '') {
            throw new Error('Title is required');
          }
          
          const db = openDb(dbPath, true);
          if (!db) throw new Error('database not found');
          
          db.transaction(() => {
            const state = materializeProject(projectId, false);
            const todo = state.todos[todoId];
            if (!todo) throw new Error(`TODO ID ${todoId} not found`);
            
            appendEvent(projectId, 'dashboard', 'TODO_UPDATED', { todo_id: todoId, title: title.trim() });
          })();
          
          invalidateProjectCache(projectId);
          db.close();
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          
          // Push update to clients
          const freshDb = openDb(dbPath, false);
          if (freshDb) {
            const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
            freshDb.close();
            pushToClients(JSON.stringify(freshData));
          }
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request', message: e.message }));
        }
      });
      return;
    }

    // ── POST /api/projects/:projectId/broadcast ────────────────────────────
    const broadcastMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/broadcast$/);
    if (req.method === 'POST' && broadcastMatch) {
      if (!isDev) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Dashboard is in read-only mode' }));
        return;
      }
      const [, projectId] = broadcastMatch;
      
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const content = payload.content;
          if (!content || typeof content !== 'string' || content.trim() === '') {
            throw new Error('Broadcast content is required');
          }
          
          const db = openDb(dbPath, true);
          if (!db) throw new Error('database not found');
          
          appendEvent(projectId, 'dashboard', 'BROADCAST', {
            from_session_id: 'dashboard',
            content: content.trim(),
            sent_at: getCurrentTimestamp()
          });
          
          invalidateProjectCache(projectId);
          db.close();
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          
          // Push update to clients
          const freshDb = openDb(dbPath, false);
          if (freshDb) {
            const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
            freshDb.close();
            pushToClients(JSON.stringify(freshData));
          }
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request', message: e.message }));
        }
      });
      return;
    }

    // ── GET /events — SSE stream ────────────────────────────────────────────
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));

      // Send current data immediately on connect
      const db = openDb(dbPath, false);
      if (db) {
        const data = buildDashboardData(db, getCurrentTimestamp());
        db.close();
        res.write(`event: data\ndata: ${JSON.stringify(data)}\n\n`);
      }
      return;
    }

    // ── GET /api/data — JSON snapshot ───────────────────────────────────────
    if (req.url === '/api/data') {
      const db = openDb(dbPath, false);
      if (!db) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'database not found' }));
        return;
      }
      const data = buildDashboardData(db, getCurrentTimestamp());
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
      return;
    }

    // ── GET / — dashboard HTML ───────────────────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

// ─── Polling loop — push updates to SSE clients every 5s ─────────────────────

function startPolling(dbPath: string, isDev: boolean, intervalMs = 5000) {
  setInterval(() => {
    if (sseClients.size === 0) return;
    const db = openDb(dbPath, isDev);
    if (!db) return;
    const data = buildDashboardData(db, getCurrentTimestamp());
    db.close();
    pushToClients(JSON.stringify(data));
  }, intervalMs);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = args.db
    ? path.resolve(process.cwd(), args.db)
    : path.join(process.cwd(), '.butler', 'butler.db');

  if (!fs.existsSync(dbPath) && !args.dev) {
    console.warn(`⚠️  Database not found: ${dbPath}`);
    console.warn(`   Dashboard will start but show "No projects" until the DB is created.`);
  }

  if (args.dev) {
    initDatabase(dbPath);
  }

  const server = createServer(dbPath, args.dev);
  startPolling(dbPath, args.dev);

  server.listen(args.port, args.host, () => {
    console.log(`\n🤵  Butler Dashboard`);
    console.log(`    URL:      http://${args.host}:${args.port}`);
    console.log(`    Database: ${dbPath}`);
    console.log(`    Mode:     ${args.dev ? 'dev-writable' : 'read-only'}`);
    console.log(`    Updates:  every 5s via SSE\n`);
    console.log(`    Press Ctrl+C to stop.\n`);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down dashboard…');
    server.close();
    process.exit(0);
  });
}

main();
