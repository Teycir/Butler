/**
 * cli/dashboardServer.ts
 *
 * HTTP request router and SSE event streaming logic for the Butler dashboard.
 */

import http from 'http';
import { now as getCurrentTimestamp } from '../constants.js';
import { appendEvent } from '../events/store.js';
import { materializeProject, invalidateProjectCache } from '../events/materializer.js';
import { renderHtml } from './dashboardRenderer.js';
import { openDb, buildDashboardData } from './dashboardHandlers.js';

export const sseClients = new Set<http.ServerResponse>();

function sendError(res: http.ServerResponse, code: number, error: string, message: string) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error, message }));
}

export function pushToClients(data: string) {
  for (const res of sseClients) {
    try {
      res.write(`event: data\ndata: ${data}\n\n`);
    } catch (err) {
      console.warn('[Butler] Failed to push update to SSE client, removing client:', err);
      sseClients.delete(res);
    }
  }
}

export function createServer(dbPath: string, isDev: boolean): http.Server {
  const html = renderHtml(dbPath, isDev);

  return http.createServer((req, res) => {
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // ── POST /api/projects/:projectId/todos/:todoId/complete ────────────────
    const completeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/todos\/([^/]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      const versionQuery = urlObj.searchParams.get('version');
      const reqVersion = (versionQuery && !isNaN(Number(versionQuery))) ? Number(versionQuery) : null;
      if (!isDev) {
        return sendError(res, 403, 'forbidden', 'Dashboard is in read-only mode');
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
          if (reqVersion !== null && todo.version !== reqVersion) {
            throw new Error(`Version mismatch for TODO ID ${todoId}. Expected version ${todo.version}, but got ${reqVersion}. Please refresh the page.`);
          }
          
          appendEvent(projectId, 'dashboard', 'TODO_COMPLETED', { todo_id: todoId, version: todo.version });
        })();
        
        invalidateProjectCache(projectId);
        db.close();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
        try {
          const freshDb = openDb(dbPath, false);
          if (freshDb) {
            const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
            freshDb.close();
            pushToClients(JSON.stringify(freshData));
          }
        } catch (pushErr: any) {
          console.error('[Butler] Failed to push update to clients after complete:', pushErr.message);
        }
      } catch (e: any) {
        sendError(res, 400, 'bad_request', e.message);
      }
      return;
    }

    // ── DELETE /api/projects/:projectId/todos/:todoId ──────────────────────
    const todoIdMatch = pathname.match(/^\/api\/projects\/([^/]+)\/todos\/([^/]+)$/);
    if (req.method === 'DELETE' && todoIdMatch) {
      const versionQuery = urlObj.searchParams.get('version');
      const reqVersion = (versionQuery && !isNaN(Number(versionQuery))) ? Number(versionQuery) : null;
      if (!isDev) {
        return sendError(res, 403, 'forbidden', 'Dashboard is in read-only mode');
      }
      const [, projectId, todoIdStr] = todoIdMatch;
      const todoId = Number(todoIdStr);
      try {
        const db = openDb(dbPath, true);
        if (!db) throw new Error('database not found');
        
        db.transaction(() => {
          const state = materializeProject(projectId, false);
          const todo = state.todos[todoId];
          if (!todo) throw new Error(`TODO ID ${todoId} not found`);
          if (reqVersion !== null && todo.version !== reqVersion) {
            throw new Error(`Version mismatch for TODO ID ${todoId}. Expected version ${todo.version}, but got ${reqVersion}. Please refresh the page.`);
          }
          
          appendEvent(projectId, 'dashboard', 'TODO_DELETED', { todo_id: todoId });
        })();
        
        invalidateProjectCache(projectId);
        db.close();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
        try {
          const freshDb = openDb(dbPath, false);
          if (freshDb) {
            const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
            freshDb.close();
            pushToClients(JSON.stringify(freshData));
          }
        } catch (pushErr: any) {
          console.error('[Butler] Failed to push update to clients after delete:', pushErr.message);
        }
      } catch (e: any) {
        sendError(res, 400, 'bad_request', e.message);
      }
      return;
    }

    // ── PATCH /api/projects/:projectId/todos/:todoId ───────────────────────
    if (req.method === 'PATCH' && todoIdMatch) {
      const versionQuery = urlObj.searchParams.get('version');
      const reqVersion = (versionQuery && !isNaN(Number(versionQuery))) ? Number(versionQuery) : null;
      if (!isDev) {
        return sendError(res, 403, 'forbidden', 'Dashboard is in read-only mode');
      }
      const [, projectId, todoIdStr] = todoIdMatch;
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
            if (reqVersion !== null && todo.version !== reqVersion) {
              throw new Error(`Version mismatch for TODO ID ${todoId}. Expected version ${todo.version}, but got ${reqVersion}. Please refresh the page.`);
            }
            
            appendEvent(projectId, 'dashboard', 'TODO_UPDATED', { todo_id: todoId, title: title.trim() });
          })();
          
          invalidateProjectCache(projectId);
          db.close();
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          
          try {
            const freshDb = openDb(dbPath, false);
            if (freshDb) {
              const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
              freshDb.close();
              pushToClients(JSON.stringify(freshData));
            }
          } catch (pushErr: any) {
            console.error('[Butler] Failed to push update to clients after update:', pushErr.message);
          }
        } catch (e: any) {
          sendError(res, 400, 'bad_request', e.message);
        }
      });
      return;
    }

    // ── POST /api/projects/:projectId/broadcast ────────────────────────────
    const broadcastMatch = req.url?.match(/^\/api\/projects\/([^/]+)\/broadcast$/);
    if (req.method === 'POST' && broadcastMatch) {
      if (!isDev) {
        return sendError(res, 403, 'forbidden', 'Dashboard is in read-only mode');
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
          
          try {
            const freshDb = openDb(dbPath, false);
            if (freshDb) {
              const freshData = buildDashboardData(freshDb, getCurrentTimestamp());
              freshDb.close();
              pushToClients(JSON.stringify(freshData));
            }
          } catch (pushErr: any) {
            console.error('[Butler] Failed to push update to clients after broadcast:', pushErr.message);
          }
        } catch (e: any) {
          sendError(res, 400, 'bad_request', e.message);
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
        return sendError(res, 503, 'database not found', 'database file is missing');
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

export function startPolling(dbPath: string, isDev: boolean, intervalMs = 5000) {
  setInterval(() => {
    if (sseClients.size === 0) return;
    const db = openDb(dbPath, isDev);
    if (!db) return;
    const data = buildDashboardData(db, getCurrentTimestamp());
    db.close();
    pushToClients(JSON.stringify(data));
  }, intervalMs);
}
