/**
 * mcp/tools/memory.tools.ts
 *
 * MCP tool definitions and handlers for memory and project management:
 *   memorystore, memorysearch, memorydelete, projectlist
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../../db/database.js';
import { appendEvent } from '../../events/store.js';
import { validateSession } from '../../coordinator/lifecycle.js';
import { searchMemories, addMemory, deleteMemory } from '../../vector/index.js';
import { sanitizeInput } from '../../validation.js';
import { MEMORY_TYPES } from '../../events/types.js';
import { SYSTEM_SESSION_ID } from '../../constants.js';
import { formatTimestamp } from '../../lib/format.js';

export const memoryToolDefs = [
  {
    name: 'memorystore',
    description: 'Store a generic semantic project memory, summary, or observation.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        type: {
          type: 'string',
          enum: ['summary', 'decision', 'rule', 'wiki'],
          description: 'Type of memory metadata'
        },
        content: { type: 'string', description: 'Content of memory' },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance rating from 0.0 to 1.0'
        },
        session_id: {
          type: 'string',
          description: 'Session ID storing the memory (used for audit trail)'
        }
      },
      required: ['project_id', 'type', 'content']
    }
  },
  {
    name: 'memorysearch',
    description: 'Search repository history and memory using hybrid local TF-IDF semantic relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        query: { type: 'string', description: 'Search term or question to rank context' },
        limit: { type: 'number', description: 'Maximum number of items to return' }
      },
      required: ['project_id', 'query']
    }
  },
  {
    name: 'memorydelete',
    description: 'Delete a memory by ID to remove stale or incorrect information.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Unique project identifier' },
        session_id: { type: 'string', description: 'Session ID performing the deletion' },
        memory_id: { type: 'number', description: 'ID of the memory to delete' }
      },
      required: ['project_id', 'memory_id']
    }
  },
  {
    name: 'projectlist',
    description: 'List all projects in the Butler database. Useful for agents initializing into an unknown workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
] as const;

export async function handleMemoryTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'memorystore': {
      const type = String(args.type);
      const content = sanitizeInput(String(args.content), 65536);

      if (!content || content.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Memory content cannot be empty');
      }

      if (!MEMORY_TYPES.includes(type as any)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid memory type: ${type}. Must be one of ${MEMORY_TYPES.map(t => `'${t}'`).join(', ')}.`
        );
      }

      if (args.session_id) {
        validateSession(projectId, String(args.session_id));
      }

      // Auto-create project if it doesn't exist (mirrors sessionregister behaviour)
      const db = getDb();
      db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

      const mem = addMemory(
        projectId,
        type as any,
        content,
        undefined,
        args.importance !== undefined ? Number(args.importance) : 0.5,
        undefined,
        undefined,
        args.session_id ? String(args.session_id) : undefined
      );

      return {
        content: [{
          type: 'text',
          text: `Memory stored successfully under ID ${mem.id} (Category: ${mem.type}, Importance: ${mem.importance})`
        }]
      };
    }

    case 'memorysearch': {
      const results = searchMemories(
        projectId,
        String(args.query),
        undefined,
        args.limit ? Number(args.limit) : 10
      );

      if (results.length === 0) {
        let text = '';
        if (results.degraded) {
          text += `⚠️ *Warning: Advanced FTS search degraded due to syntax error ("${results.reason}"). Falling back to unranked matching.*\n\n`;
        }
        text += 'No matching memory logs found in local database.';
        return { content: [{ type: 'text', text }] };
      }

      let responseText = '';
      if (results.degraded) {
        responseText += `⚠️ *Warning: Advanced FTS search degraded due to syntax error ("${results.reason}"). Falling back to unranked matching.*\n\n`;
      }
      responseText += `### Semantic Search Results for "${args.query}"\n\n`;
      
      for (const r of results) {
        responseText +=
          `**[ID ${r.memory.id}] ${r.memory.type.toUpperCase()} ` +
          `(Score: ${(r.score * 100).toFixed(1)}%, ` +
          `Keyword Match: ${(r.relevance * 100).toFixed(1)}%, ` +
          `Recency: ${(r.recency * 100).toFixed(1)}%)**\n` +
          `> ${r.memory.content}\n\n`;
      }

      return { content: [{ type: 'text', text: responseText }] };
    }

    case 'memorydelete': {
      const memoryId = Number(args.memory_id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        throw new McpError(ErrorCode.InvalidParams, 'memory_id must be a positive integer');
      }

      if (args.session_id) {
        validateSession(projectId, String(args.session_id));
      }

      const db = getDb();
      db.transaction(() => {
        const row = db.prepare('SELECT id FROM memories WHERE id = ? AND project_id = ?')
          .get(memoryId, projectId);
        if (!row) {
          throw new McpError(ErrorCode.InvalidRequest, `Memory ID ${memoryId} not found in project ${projectId}.`);
        }

        deleteMemory(projectId, memoryId);

        const sessionIdForEvent = args.session_id ? String(args.session_id) : SYSTEM_SESSION_ID;
        appendEvent(projectId, sessionIdForEvent, 'MEMORY_DELETED', { memory_id: memoryId });
      })();

      return { content: [{ type: 'text', text: `Memory ID ${memoryId} deleted from project ${projectId}.` }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown memory tool: ${name}`);
  }
}

/**
 * Handle projectlist separately — it has no project_id requirement.
 */
export function handleProjectList(): { content: Array<{ type: string; text: string }> } {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, created_at FROM projects ORDER BY created_at ASC'
  ).all() as Array<{ id: string; name: string; created_at: number }>;

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No projects found in the Butler database. Call `sessionregister` with project_id, session_id, and client_type to get started.'
      }]
    };
  }

  const projectList = rows.map(r => ({
    id: r.id,
    name: r.name,
    created_at: formatTimestamp(r.created_at)
  }));

  return { content: [{ type: 'text', text: JSON.stringify(projectList, null, 2) }] };
}
