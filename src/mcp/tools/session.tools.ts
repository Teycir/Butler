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
  gracefulDisconnect
} from '../../coordinator/lifecycle.js';

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
          description: 'Unique session identifier. Must contain only alphanumeric characters, underscores, and hyphens (e.g. cursor-1, claude-desktop-2, kiro_cli_4)'
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
      const sess = registerSession(projectId, String(args.session_id), String(args.client_type));
      return {
        content: [{
          type: 'text',
          text: `Successfully registered session ${sess.id} for project ${sess.project_id} (Client: ${sess.client_type}, Status: ${sess.status})`
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
