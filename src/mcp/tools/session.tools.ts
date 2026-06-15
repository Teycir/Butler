/**
 * mcp/tools/session.tools.ts
 *
 * MCP tool definitions and handlers for session lifecycle:
 *   sessionregister, sessionheartbeat, sessiondisconnect
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  registerSession,
  processHeartbeat,
  gracefulDisconnect,
  getActiveSessions
} from '../../coordinator/lifecycle.js';
import { getDb } from '../../db/database.js';
import { materializeProject } from '../../events/materializer.js';
import { now as getCurrentTimestamp } from '../../constants.js';

export const sessionToolDefs = [
  {
    name: 'sessionregister',
    description: 'Register a new active agent session connection.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: {
          type: 'string',
          description: 'Unique session identifier. Convention: {client}-{role}-{number}. Examples: "cursor-main-1", "claude-planner-1", "kiro-tester-2". Auto-generated suggestion: use "{client_type}-{Date.now()}"'
        },
        client_type: { type: 'string', description: 'Client description (e.g., Cursor, Claude Desktop)' }
      },
      required: ['project_id', 'session_id', 'client_type']
    }
  },
  {
    name: 'sessionheartbeat',
    description: 'Send a standard heartbeat signal to preserve session presence (should be run every 15s).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Unique session identifier' }
      },
      required: ['project_id', 'session_id']
    }
  },
  {
    name: 'sessiondisconnect',
    description: 'Gracefully disconnect and shut down an active session connection, immediately flushing a handoff log.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Unique session identifier' }
      },
      required: ['project_id', 'session_id']
    }
  }
] as const;

export async function handleSessionTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'sessionregister': {
      const db = getDb();
      const existing = db.prepare('SELECT last_event_seen FROM sessions WHERE id = ?').get(args.session_id) as any;
      const lastEventSeen = existing ? Number(existing.last_event_seen) : 0;

      const sess = registerSession(projectId, String(args.session_id), String(args.client_type));
      
      const otherSessions = getActiveSessions(projectId).filter(s => s.id !== sess.id);
      const state = materializeProject(projectId, false);
      const openTodos = Object.values(state.todos).filter(t => t.status === 'pending');
      const unclaimed = openTodos.filter(t => !t.claimed_by).length;
      const inProgress = openTodos.filter(t => t.claimed_by).length;
      const unreadBroadcasts = state.broadcasts.filter(b => b.event_id > lastEventSeen && b.from_session_id !== sess.id);

      const otherSessionsStr = otherSessions.length > 0
        ? otherSessions.map(s => `${s.id} (${s.status}, ${Math.max(0, getCurrentTimestamp() - s.last_heartbeat)}s ago)`).join(', ')
        : 'none';

      let text = `✅ Session registered: ${sess.id}
📦 Project: ${projectId}
🤖 Other active sessions: ${otherSessionsStr}
📋 ${openTodos.length} open TODOs (${unclaimed} unclaimed, ${inProgress} in-progress)`;

      if (unreadBroadcasts.length > 0) {
        const senders = Array.from(new Set(unreadBroadcasts.map(b => b.from_session_id)));
        text += `\n📢 ${unreadBroadcasts.length} unread broadcast${unreadBroadcasts.length > 1 ? 's' : ''} from ${senders.join(', ')}`;
      }

      const genericPatterns = /^(agent|session|client|user|helper|bot|ai|mcp|test|claude|cursor)([-_]?\d*)?$/i;
      if (genericPatterns.test(sess.id)) {
        const suggested = `${sess.client_type || 'agent'}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        text += `\n💡 Tip: Your session ID looks generic. Consider using a more specific ID like: "${suggested}"`;
      }

      return {
        content: [{
          type: 'text',
          text
        }]
      };
    }

    case 'sessionheartbeat': {
      processHeartbeat(projectId, String(args.session_id));
      return {
        content: [{
          type: 'text',
          text: `Heartbeat acknowledged for session ${args.session_id} in project ${projectId}`
        }]
      };
    }

    case 'sessiondisconnect': {
      gracefulDisconnect(projectId, String(args.session_id));
      return {
        content: [{
          type: 'text',
          text: `Session ${args.session_id} gracefully disconnected from project ${projectId}. Structured handoff successfully broadcast.`
        }]
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown session tool: ${name}`);
  }
}
