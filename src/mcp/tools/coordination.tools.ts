/**
 * mcp/tools/coordination.tools.ts
 *
 * Phase 3 — Multi-Agent Coordination
 *
 * MCP tool definitions and handlers for:
 *   todoclaim      (3.2) — claim a TODO as actively being worked
 *   todounclaim    (3.2) — release a claim
 *   messagesend    (3.3) — send a direct message to another session
 *   broadcast      (3.4) — announce something to all active sessions
 *
 * Conflict detection (3.1) is integrated into todo.tools.ts via the
 * detectAndRecordConflict helper exported from this module.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { materializeProject, invalidateProjectCache } from '../../events/materializer.js';
import { appendEvent } from '../../events/store.js';
import { getDb } from '../../db/database.js';
import { validateSession, updateLastEventSeen, getActiveSessions } from '../../coordinator/lifecycle.js';
import { sanitizeInput } from '../../validation.js';
import { now as getCurrentTimestamp, CONFLICT_WINDOW_SECS } from '../../constants.js';
import { handleSyncContext } from './coordination/sync.js';

export const coordinationToolDefs = [
  {
    name: 'todoclaim',
    description:
      'Claim a TODO as actively being worked by your session. ' +
      'Other agents will see it as claimed in shared context, preventing duplicate work. ' +
      'Claims expire automatically when the session goes stale.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Your session ID' },
        todo_id: { type: 'number', description: 'ID of the TODO to claim' }
      },
      required: ['project_id', 'session_id', 'todo_id']
    }
  },
  {
    name: 'todounclaim',
    description: 'Release your claim on a TODO, making it available for other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Your session ID' },
        todo_id: { type: 'number', description: 'ID of the TODO to unclaim' }
      },
      required: ['project_id', 'session_id', 'todo_id']
    }
  },
  {
    name: 'messagesend',
    description:
      'Send a direct message to another active session. ' +
      'The recipient will see it in their next context read under 📬 Messages. ' +
      'Use for lightweight async coordination ("I\'m about to refactor auth.ts — hold off on that area").',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Your session ID (sender)' },
        to_session_id: { type: 'string', description: 'Target session ID (recipient)' },
        content: { type: 'string', description: 'Message content (max 2048 chars)' }
      },
      required: ['project_id', 'session_id', 'to_session_id', 'content']
    }
  },
  {
    name: 'broadcast',
    description:
      'Broadcast an announcement to all active sessions. ' +
      'Visible to every agent in their next context read under 📢 Broadcasts. ' +
      'Use for major announcements ("Starting a large refactor of the auth module").',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Your session ID' },
        content: { type: 'string', description: 'Broadcast message content (max 1024 chars)' }
      },
      required: ['project_id', 'session_id', 'content']
    }
  },
  {
    name: 'synccontext',
    description: 'Detects active peer AI sessions and synchronizes workspace context on-demand.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Your session ID' },
        confirm_sync: { type: 'boolean', description: 'Pass true to accept the sync and align contexts, false or omit to check status.' }
      },
      required: ['project_id', 'session_id']
    }
  }
] as const;

export async function handleCoordinationTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'todoclaim': {
      validateSession(projectId, String(args.session_id));
      const todoId = Number(args.todo_id);

      const event = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const todo = state.todos[todoId];

        if (!todo) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_not_found',
              message: `TODO ID ${todoId} not found.`,
              hint: 'Verify the todo_id is correct by listing TODOs.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }
        if (todo.status === 'completed') {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_already_completed',
              message: `TODO ID ${todoId} is already completed — cannot claim it.`,
              hint: 'You cannot claim a completed task.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }
        if (todo.claimed_by && todo.claimed_by !== String(args.session_id)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_already_claimed',
              message: `TODO ID ${todoId} is already claimed by session "${todo.claimed_by}".`,
              hint: 'Use todounclaim if that session is stale, or coordinate directly.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }

        const ev = appendEvent(projectId, String(args.session_id), 'TODO_CLAIMED', {
          todo_id: todoId,
          session_id: String(args.session_id),
          claimed_at: getCurrentTimestamp()
        });
        updateLastEventSeen(String(args.session_id), ev.id);
        return ev;
      })();

      invalidateProjectCache(projectId);
      return {
        content: [{
          type: 'text',
          text: `TODO ID ${todoId} claimed by session "${args.session_id}". Other agents will see it as in-progress. (Event ID: ${event.id})`
        }]
      };
    }

    case 'todounclaim': {
      validateSession(projectId, String(args.session_id));
      const todoId = Number(args.todo_id);

      const event = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const todo = state.todos[todoId];

        if (!todo) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_not_found',
              message: `TODO ID ${todoId} not found.`,
              hint: 'Verify the todo_id is correct by listing TODOs.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }
        if (!todo.claimed_by) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_not_claimed',
              message: `TODO ID ${todoId} has no active claim to release.`,
              hint: 'You can only release claims that are actively held.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }
        if (todo.claimed_by !== String(args.session_id)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            JSON.stringify({
              error: 'todo_claim_owner_mismatch',
              message: `Cannot unclaim TODO ID ${todoId} — it is held by session "${todo.claimed_by}", not "${args.session_id}".`,
              hint: 'Only the session holding the claim (or system force-release) can release it.',
              docs: 'https://github.com/Teycir/Butler#todo-management'
            })
          );
        }

        const ev = appendEvent(projectId, String(args.session_id), 'TODO_UNCLAIMED', {
          todo_id: todoId,
          session_id: String(args.session_id)
        });
        updateLastEventSeen(String(args.session_id), ev.id);
        return ev;
      })();

      invalidateProjectCache(projectId);
      return {
        content: [{
          type: 'text',
          text: `Claim on TODO ID ${todoId} released. It is now available for other agents. (Event ID: ${event.id})`
        }]
      };
    }

    case 'messagesend': {
      validateSession(projectId, String(args.session_id));
      const toSessionId = String(args.to_session_id);
      const content = sanitizeInput(String(args.content), 2048);

      if (toSessionId === String(args.session_id)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          JSON.stringify({
            error: 'message_self_invalid',
            message: 'Cannot send a message to yourself.',
            hint: 'Specify a different, active session ID as the recipient.',
            docs: 'https://github.com/Teycir/Butler#coordination-messaging'
          })
        );
      }

      // Warn if recipient session is not currently active, but don't block —
      // the message is still written to the event log and will appear on reconnect.
      const sessions = getActiveSessions(projectId);
      const recipientAlive = sessions.some(s => s.id === toSessionId && s.status === 'alive');
      const recipientExists = sessions.some(s => s.id === toSessionId);

      const event = appendEvent(projectId, String(args.session_id), 'MESSAGE_SENT', {
        from_session_id: String(args.session_id),
        to_session_id: toSessionId,
        content,
        sent_at: getCurrentTimestamp()
      });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);

      let responseText = `Message sent to session "${toSessionId}". (Event ID: ${event.id})`;
      if (!recipientExists) {
        responseText += `\n⚠️  Session "${toSessionId}" is not registered in this project — the message is stored and will appear when they connect.`;
      } else if (!recipientAlive) {
        responseText += `\n⚠️  Session "${toSessionId}" appears stale — the message is stored and will appear when they reconnect.`;
      }

      return { content: [{ type: 'text', text: responseText }] };
    }

    case 'broadcast': {
      validateSession(projectId, String(args.session_id));
      const content = sanitizeInput(String(args.content), 1024);

      const event = appendEvent(projectId, String(args.session_id), 'BROADCAST', {
        from_session_id: String(args.session_id),
        content,
        sent_at: getCurrentTimestamp()
      });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);

      const activeSessions = getActiveSessions(projectId).filter(s => s.id !== String(args.session_id) && s.status === 'alive');
      const recipientCount = activeSessions.length;
      const recipientNote = recipientCount === 0
        ? ' No other active sessions at this time, but it will appear in context for any agent that connects.'
        : ` ${recipientCount} other active session(s) will see this in their next context read.`;

      return {
        content: [{
          type: 'text',
          text: `Broadcast sent. (Event ID: ${event.id})${recipientNote}`
        }]
      };
    }

    case 'synccontext': {
      return handleSyncContext(args, projectId);
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown coordination tool: ${name}`);
  }
}

/**
 * Phase 3.1 — Conflict detection helper.
 *
 * Called from todo.tools.ts inside the todocomplete / todoupdate transactions,
 * AFTER the version check passes but BEFORE the write, to detect concurrent
 * mutations from other sessions on the same TODO within a short time window.
 *
 * If a conflict is detected, a TODO_CONFLICT event is appended alongside the
 * primary mutation event so that all sessions see the warning in context.
 */
export function detectAndRecordConflict(
  projectId: string,
  todoId: number,
  writingSessionId: string,
  lastUpdatedBy: string,
  lastUpdatedAt: number,
  conflictType: 'concurrent_complete' | 'concurrent_update'
): string | null {
  // A conflict exists when another session touched this TODO very recently.
  if (lastUpdatedBy === writingSessionId) return null; // same session, no conflict
  const ageOfLastWrite = getCurrentTimestamp() - lastUpdatedAt;
  if (ageOfLastWrite > CONFLICT_WINDOW_SECS) return null; // old enough, no conflict

  const sessions = [writingSessionId, lastUpdatedBy];
  const hintText = conflictType === 'concurrent_complete'
    ? `Both sessions marked #${todoId} complete within ${ageOfLastWrite}s. Suggest: verify final state matches expectations and delete duplicate event if needed.`
    : `Both sessions updated #${todoId} within ${ageOfLastWrite}s. Suggest: verify final state matches expectations and reconcile differences if needed.`;

  const conflictEvent = appendEvent(projectId, writingSessionId, 'TODO_CONFLICT', {
    todo_id: todoId,
    conflicting_session_id: lastUpdatedBy,
    conflict_type: conflictType,
    conflicting_sessions: sessions,
    hint: hintText
  });
  // Advance last_event_seen so the conflict event appears in this session's own
  // handoff diff (getSessionEvents uses sinceEventId = sess.last_event_seen).
  updateLastEventSeen(writingSessionId, conflictEvent.id);
  return hintText;
}
