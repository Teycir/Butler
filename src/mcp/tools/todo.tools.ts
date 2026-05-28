/**
 * mcp/tools/todo.tools.ts
 *
 * MCP tool definitions and handlers for TODO management:
 *   todoadd, todocomplete, todoupdate, tododelete, todolist
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { materializeProject, invalidateProjectCache } from '../../events/materializer.js';
import { appendEvent, getNextSequenceValue } from '../../events/store.js';
import { getDb } from '../../db/database.js';
import { validateSession, updateLastEventSeen } from '../../coordinator/lifecycle.js';
import { sanitizeTitle } from '../../validation.js';
import { detectAndRecordConflict } from './coordination.tools.js';

export const todoToolDefs = [
  {
    name: 'todoadd',
    description: 'Create and broadcast a shared TODO task.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Session ID creating the task' },
        title: { type: 'string', description: 'Task title or summary description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task severity/urgency' }
      },
      required: ['project_id', 'session_id', 'title']
    }
  },
  {
    name: 'todocomplete',
    description: 'Mark a shared TODO task as completed with optimistic version checking.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Session ID completing the task' },
        todo_id: { type: 'number', description: 'ID of the TODO to mark complete' },
        version: { type: 'number', description: 'The expected current version of the task' }
      },
      required: ['project_id', 'session_id', 'todo_id', 'version']
    }
  },
  {
    name: 'todoupdate',
    description: 'Update a TODO task title, priority, or status with optimistic version checking.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Session ID updating the task' },
        todo_id: { type: 'number', description: 'ID of the TODO to update' },
        version: { type: 'number', description: 'The expected current version of the task' },
        title: { type: 'string', description: 'New task title (optional)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority (optional)' },
        status: { type: 'string', enum: ['pending', 'completed'], description: 'New status (optional)' }
      },
      required: ['project_id', 'session_id', 'todo_id', 'version']
    }
  },
  {
    name: 'tododelete',
    description: 'Delete a TODO task with optimistic version checking.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Session ID deleting the task' },
        todo_id: { type: 'number', description: 'ID of the TODO to delete' },
        version: { type: 'number', description: 'The expected current version of the task' }
      },
      required: ['project_id', 'session_id', 'todo_id', 'version']
    }
  },
  {
    name: 'todolist',
    description: 'List all TODOs in the project. Alternative to the butler://projects/{id}/todos resource.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        status: { type: 'string', enum: ['pending', 'completed', 'all'], description: 'Filter by status (default: pending)' }
      },
      required: ['project_id']
    }
  }
] as const;

export async function handleTodoTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'todoadd': {
      validateSession(projectId, String(args.session_id));
      const nextId = getNextSequenceValue(projectId, 'todo');
      const title = sanitizeTitle(String(args.title));
      const priority = (args.priority as 'low' | 'medium' | 'high' | undefined) ?? 'medium';

      const event = appendEvent(projectId, String(args.session_id), 'TODO_CREATED', {
        todo_id: nextId, title, priority
      });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);

      return {
        content: [{
          type: 'text',
          text: `Shared TODO successfully created! [ID: ${nextId}] "${title}" (Event ID: ${event.id})`
        }]
      };
    }

    case 'todocomplete': {
      validateSession(projectId, String(args.session_id));
      const todoId = Number(args.todo_id);
      const reqVersion = Number(args.version);

      const event = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const todo = state.todos[todoId];

        if (!todo) throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
        if (todo.status === 'completed') throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} is already completed.`);
        if (todo.version !== reqVersion) throw new McpError(
          ErrorCode.InvalidParams,
          `Version mismatch for TODO ID ${todoId}. Expected ${todo.version}, got ${reqVersion}. Fetch and retry.`
        );

        // Phase 3.1 — detect concurrent writes from other sessions
        detectAndRecordConflict(projectId, todoId, String(args.session_id), todo.updated_by, todo.updated_at, 'concurrent_complete');

        const ev = appendEvent(projectId, String(args.session_id), 'TODO_COMPLETED', { todo_id: todoId, version: reqVersion });
        updateLastEventSeen(String(args.session_id), ev.id);
        return ev;
      })();

      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `Shared TODO ID ${todoId} marked as completed! (Event ID: ${event.id})` }] };
    }

    case 'todoupdate': {
      validateSession(projectId, String(args.session_id));
      const todoId = Number(args.todo_id);
      const reqVersion = Number(args.version);

      const event = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const todo = state.todos[todoId];

        if (!todo) throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
        if (todo.version !== reqVersion) throw new McpError(
          ErrorCode.InvalidParams,
          `Version mismatch for TODO ID ${todoId}. Expected ${todo.version}, got ${reqVersion}. Fetch and retry.`
        );

        // Phase 3.1 — detect concurrent writes from other sessions
        detectAndRecordConflict(projectId, todoId, String(args.session_id), todo.updated_by, todo.updated_at, 'concurrent_update');

        const ev = appendEvent(projectId, String(args.session_id), 'TODO_UPDATED', {
          todo_id: todoId,
          title: args.title !== undefined ? sanitizeTitle(String(args.title)) : undefined,
          priority: args.priority as 'low' | 'medium' | 'high' | undefined,
          status: args.status as 'pending' | 'completed' | undefined
        });
        updateLastEventSeen(String(args.session_id), ev.id);
        return ev;
      })();

      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `TODO ID ${todoId} updated! (Event ID: ${event.id})` }] };
    }

    case 'tododelete': {
      validateSession(projectId, String(args.session_id));
      const todoId = Number(args.todo_id);
      const reqVersion = Number(args.version);

      const event = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const todo = state.todos[todoId];

        if (!todo) throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
        if (todo.version !== reqVersion) throw new McpError(
          ErrorCode.InvalidParams,
          `Version mismatch for TODO ID ${todoId}. Expected ${todo.version}, got ${reqVersion}. Fetch and retry.`
        );

        const ev = appendEvent(projectId, String(args.session_id), 'TODO_DELETED', { todo_id: todoId });
        updateLastEventSeen(String(args.session_id), ev.id);
        return ev;
      })();

      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `TODO ID ${todoId} deleted! (Event ID: ${event.id})` }] };
    }

    case 'todolist': {
      const state = materializeProject(projectId, false);
      const todos = Object.values(state.todos);
      const filterStatus = args.status as string | undefined;
      const filtered = (!filterStatus || filterStatus === 'all')
        ? todos
        : todos.filter(t => t.status === filterStatus);

      const sorted = filtered.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        return a.id - b.id;
      });
      return { content: [{ type: 'text', text: JSON.stringify(sorted, null, 2) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown todo tool: ${name}`);
  }
}
