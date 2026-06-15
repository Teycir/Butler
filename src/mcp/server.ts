/**
 * mcp/server.ts
 *
 * Butler MCP Server — orchestrates resources and tools.
 *
 * Responsibilities:
 *   - Server initialisation and transport wiring
 *   - Request routing to resource / tool modules
 *   - Cross-cutting concerns: project_id validation, session_id validation,
 *     auto-registration of missing sessions, and auto-register warning injection
 *
 * Actual tool logic lives in:
 *   mcp/tools/session.tools.ts   — sessionregister, sessionheartbeat, sessiondisconnect
 *   mcp/tools/todo.tools.ts      — todoadd, todocomplete, todoupdate, tododelete, todolist
 *   mcp/tools/knowledge.tools.ts — wikiupdate, ruleadd, ruleremove, decisionrecord, handoffcreate
 *   mcp/tools/memory.tools.ts    — memorystore, memorysearch, memorydelete, projectlist
 *
 * Resource logic lives in:
 *   mcp/resources.ts             — context, todos, wiki, sessions, memories, diff
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  InitializedNotificationSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { validateProjectId, validateSessionId } from '../validation.js';
import { getDefaultProjectId } from '../project-config.js';
import { ensureSession } from '../coordinator/lifecycle.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

import { resourceDefs, handleReadResource } from './resources.js';
import { sessionToolDefs, handleSessionTool } from './tools/session.tools.js';
import { todoToolDefs, handleTodoTool } from './tools/todo.tools.js';
import { knowledgeToolDefs, handleKnowledgeTool } from './tools/knowledge.tools.js';
import { memoryToolDefs, handleMemoryTool, handleProjectList } from './tools/memory.tools.js';
import { coordinationToolDefs, handleCoordinationTool } from './tools/coordination.tools.js';
import { observabilityToolDefs, handleObservabilityTool } from './tools/observability.tools.js';

// ---------------------------------------------------------------------------
// Tool routing helpers
// ---------------------------------------------------------------------------

const SESSION_TOOLS      = new Set(sessionToolDefs.map(t => t.name));
const TODO_TOOLS         = new Set(todoToolDefs.map(t => t.name));
const KNOWLEDGE_TOOLS    = new Set(knowledgeToolDefs.map(t => t.name));
const MEMORY_TOOLS       = new Set(memoryToolDefs.map(t => t.name));
const COORDINATION_TOOLS    = new Set(coordinationToolDefs.map(t => t.name));
const OBSERVABILITY_TOOLS   = new Set(observabilityToolDefs.map(t => t.name));

/** Tools that manage session lifecycle and must not trigger auto-registration. */
const SESSION_LIFECYCLE_TOOLS = new Set(['sessionregister', 'sessionheartbeat', 'sessiondisconnect']);

// ---------------------------------------------------------------------------
// ButlerMcpServer
// ---------------------------------------------------------------------------

export class ButlerMcpServer {
  private server: Server;

  constructor() {
    // Note: Butler intentionally has no authentication layer.
    // Any MCP-connected AI agent can read/write to any project by design.
    // This is appropriate for local stdio transport where the security boundary
    // is the user's machine. Project IDs and session IDs are the only identifiers.
    this.server = new Server(
      { name: 'butler-mcp', version: '1.0.0' },
      {
        capabilities: { resources: {}, tools: {} },
        instructions: SERVER_INSTRUCTIONS
      }
    );

    this.setupResources();
    this.setupTools();
    this.setupNotifications();
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  private setupResources() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resourceDefs
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return handleReadResource(request.params.uri);
    });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...sessionToolDefs,
        ...todoToolDefs,
        ...knowledgeToolDefs,
        ...memoryToolDefs,
        ...coordinationToolDefs,
        ...observabilityToolDefs
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      let args: Record<string, any> = request.params.arguments ?? {};

      // projectlist has no project_id requirement — handle before any validation
      if (name === 'projectlist') {
        try {
          return handleProjectList();
        } catch (err: any) {
          if (err instanceof McpError) throw err;
          return { isError: true, content: [{ type: 'text', text: `Internal error: ${err.message}` }] };
        }
      }

      // Resolve project_id — fall back to .butler/project.json when omitted
      if (!args.project_id || typeof args.project_id !== 'string' || args.project_id.trim() === '') {
        const defaultId = getDefaultProjectId();
        if (defaultId) {
          args = { ...args, project_id: defaultId };
        } else {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Missing required parameter: project_id. ` +
            `Tip: create .butler/project.json with {"project_id":"<name>"} in your repo root to set a default.`
          );
        }
      }

      const projectId = String(args.project_id);
      validateProjectId(projectId);

      if (args.session_id !== undefined) {
        if (typeof args.session_id !== 'string' || args.session_id.trim() === '') {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid session_id: must be a non-empty string');
        }
        validateSessionId(String(args.session_id));
      }

      // Auto-register: silently create the session if it doesn't exist yet,
      // then append a warning to the response so the agent is informed.
      let autoRegisteredWarning: string | null = null;
      if (args.session_id && !SESSION_LIFECYCLE_TOOLS.has(name)) {
        const { wasAutoRegistered } = ensureSession(projectId, String(args.session_id), 'unknown');
        if (wasAutoRegistered) {
          autoRegisteredWarning =
            `\n\n⚠️  Session "${args.session_id}" was not registered — auto-registered for project "${projectId}". ` +
            `Call sessionregister explicitly on startup for full session tracking.`;
        }
      }

      try {
        const result = await this.dispatchTool(name, args, projectId);

        if (autoRegisteredWarning && result?.content?.[0]?.type === 'text') {
          result.content[0].text += autoRegisteredWarning;
        }

        return result;
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        return { isError: true, content: [{ type: 'text', text: `Internal processing error: ${err.message}` }] };
      }
    });
  }

  private async dispatchTool(name: string, args: Record<string, any>, projectId: string) {
    if (SESSION_TOOLS.has(name as any))      return handleSessionTool(name as any, args, projectId);
    if (TODO_TOOLS.has(name as any))         return handleTodoTool(name as any, args, projectId);
    if (KNOWLEDGE_TOOLS.has(name as any))    return handleKnowledgeTool(name as any, args, projectId);
    if (MEMORY_TOOLS.has(name as any))       return handleMemoryTool(name as any, args, projectId);
    if (COORDINATION_TOOLS.has(name as any)) return handleCoordinationTool(name as any, args, projectId);
    if (OBSERVABILITY_TOOLS.has(name as any))return handleObservabilityTool(name as any, args, projectId);
    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  private setupNotifications() {
    // Hook notifications/initialized — fired by the client right after the
    // handshake, before any tool call. Use it to auto-register a synthetic
    // session when a default project is configured.
    this.server.setNotificationHandler(InitializedNotificationSchema, async () => {
      const projectId = getDefaultProjectId();
      if (!projectId) return; // No default project — skip auto-registration.

      // Derive a synthetic session ID from the PID and startup timestamp so that
      // restarted client processes do not collide with recycled PIDs in handoff history.
      const syntheticSessionId = `auto-${process.pid}-${Date.now()}`;

      try {
        const { wasAutoRegistered } = ensureSession(projectId, syntheticSessionId, 'auto');
        if (wasAutoRegistered) {
          console.error(
            `[Butler] Auto-registered session "${syntheticSessionId}" for project "${projectId}" ` +
            `via notifications/initialized. Call sessionregister explicitly for full tracking.`
          );
        }
      } catch (e) {
        // Non-fatal — if auto-registration fails (e.g. invalid project_id in config),
        // log and continue. The agent can still call sessionregister manually.
        console.error('[Butler] Auto-registration on initialized failed:', e);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // NOTE: We MUST use console.error for server logs. stdout MUST remain clean
    // for JSON-RPC transport protocol packets.
    console.error('Butler MCP Server running on stdio');
  }
}
