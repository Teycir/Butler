/**
 * mcp/resources.ts
 *
 * MCP resource definitions and handlers for Butler.
 * Handles: context, todos, wiki, sessions, memories, diff
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { materializeProject } from '../events/materializer.js';
import { getActiveSessions } from '../coordinator/lifecycle.js';
import { getMemories } from '../vector/index.js';
import { buildContextResource } from './resources/context.js';
import { buildDiffResource } from './resources/diff.js';
import { validateProjectId } from '../validation.js';
import { getDb } from '../db/database.js';

export const resourceDefs = [
  {
    uri: 'butler://projects/{projectId}/context',
    name: 'Project Unified Context',
    description: 'A consolidated active context packet containing TODOs, rules, wiki pages, and active sessions.',
    mimeType: 'text/markdown'
  },
  {
    uri: 'butler://projects/{projectId}/todos',
    name: 'Active TODO list',
    description: 'Materialized active tasks and issues with priority and completion states.',
    mimeType: 'application/json'
  },
  {
    uri: 'butler://projects/{projectId}/wiki',
    name: 'Project Wiki and Documents',
    description: 'Accumulated wiki knowledge bases and reference documents.',
    mimeType: 'application/json'
  },
  {
    uri: 'butler://projects/{projectId}/sessions',
    name: 'Live Connected Sessions',
    description: 'Active agent connections and heartbeats.',
    mimeType: 'application/json'
  },
  {
    uri: 'butler://projects/{projectId}/memories',
    name: 'Universal Memories Log',
    description: 'List of all stored project summaries, decisions, guidelines, and wiki pages.',
    mimeType: 'application/json'
  },
  {
    uri: 'butler://projects/{projectId}/diff',
    name: 'Project Event Diff',
    description:
      'Compact changelog of state changes since a given event ID. Pass ?since={eventId} to scope the diff. ' +
      'Returns grouped human-readable entries for TODOs, rules, decisions, wiki, and session changes.',
    mimeType: 'application/json'
  },
  {
    uri: 'butler://projects/{projectId}/orchestration',
    name: 'Project Orchestration Checkpoints',
    description: 'LangGraph orchestration checkpoints and execution state.',
    mimeType: 'application/json'
  }
];

/** Parse a butler:// URI and return { projectId, resourceType, queryParams }. */
function parseResourceUri(uri: string) {
  const match = uri.match(/^butler:\/\/projects\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
  if (!match) {
    throw new McpError(ErrorCode.InvalidRequest, `Unknown or invalid resource URI: ${uri}`);
  }

  const [, projectId, resourceType, queryString] = match;

  validateProjectId(projectId);

  const queryParams: Record<string, string> = {};
  if (queryString) {
    for (const part of queryString.split('&')) {
      const [k, v] = part.split('=');
      if (k && v !== undefined) queryParams[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }

  return { projectId, resourceType, queryParams };
}

export async function handleReadResource(uri: string) {
  const { projectId, resourceType, queryParams } = parseResourceUri(uri);

  switch (resourceType) {
    case 'todos': {
      const state = materializeProject(projectId, false);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(Object.values(state.todos), null, 2)
        }]
      };
    }

    case 'wiki': {
      const state = materializeProject(projectId, false);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(Object.values(state.wiki), null, 2)
        }]
      };
    }

    case 'sessions': {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(getActiveSessions(projectId), null, 2)
        }]
      };
    }

    case 'memories': {
      const memoriesList = getMemories(projectId);
      const sanitized = memoriesList.map(({ embedding, ...rest }) => rest);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized, null, 2)
        }]
      };
    }

    case 'context':
      return buildContextResource(uri, projectId);

    case 'diff':
      return buildDiffResource(uri, projectId, queryParams);
      
    case 'orchestration': {
      const db = getDb();
      const rows = db.prepare(`
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? OR thread_id LIKE ?
        ORDER BY checkpoint_id DESC
      `).all(projectId, `${projectId}-%`) as any[];

      const checkpoints = rows.map(r => {
        let checkpointObj: any = null;
        let metadataObj: any = null;
        try {
          if (r.checkpoint) checkpointObj = JSON.parse(r.checkpoint.toString('utf-8'));
        } catch {
          checkpointObj = r.checkpoint ? r.checkpoint.toString('hex') : null;
        }
        try {
          if (r.metadata) metadataObj = JSON.parse(r.metadata.toString('utf-8'));
        } catch {
          metadataObj = r.metadata ? r.metadata.toString('hex') : null;
        }
        return {
          thread_id: r.thread_id,
          checkpoint_ns: r.checkpoint_ns,
          checkpoint_id: r.checkpoint_id,
          parent_checkpoint_id: r.parent_checkpoint_id,
          type: r.type,
          checkpoint: checkpointObj,
          metadata: metadataObj
        };
      });

      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(checkpoints, null, 2)
        }]
      };
    }

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource subpath: ${resourceType}`);
  }
}
