import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { 
  materializeProject, 
  TodoItem, 
  WikiPage, 
  DecisionItem,
  invalidateProjectCache 
} from '../events/materializer.js';
import { appendEvent, getNextSequenceValue } from '../events/store.js';
import { MEMORY_TYPES } from '../events/types.js';
import { getDb } from '../db/database.js';
import { 
  processHeartbeat, 
  registerSession, 
  getActiveSessions, 
  gracefulDisconnect,
  validateSession,
  updateLastEventSeen
} from '../coordinator/lifecycle.js';
import { searchMemories, addMemory, getMemories } from '../vector/index.js';

export class ButlerMcpServer {
  private server: Server;

  constructor() {
    // Note: Butler intentionally has no authentication layer.
    // Any MCP-connected AI agent can read/write to any project by design.
    // This is appropriate for local stdio transport where the security boundary
    // is the user's machine. Project IDs and session IDs are the only identifiers.
    this.server = new Server(
      {
        name: 'butler-mcp',
        version: '1.0.0'
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    );

    this.setupResources();
    this.setupTools();
  }

  private setupResources() {
    // 1. List Available Resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
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
          }
        ]
      };
    });

    // 2. Read Specific Resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      
      // Parse butler://projects/{projectId}/{resourceType}
      const match = uri.match(/^butler:\/\/projects\/([^/]+)\/([^/]+)$/);
      if (!match) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown or invalid resource URI: ${uri}`);
      }

      const [, projectId, resourceType] = match;
      
      // Validate project ID format
      if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid project_id format. Only alphanumeric characters, underscores, and hyphens are allowed.`
        );
      }

      switch (resourceType) {
        case 'todos': {
          const state = materializeProject(projectId, false);
          const todosList = Object.values(state.todos);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(todosList, null, 2)
              }
            ]
          };
        }

        case 'wiki': {
          const state = materializeProject(projectId, false);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(Object.values(state.wiki), null, 2)
              }
            ]
          };
        }

        case 'sessions': {
          const sessions = getActiveSessions(projectId);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(sessions, null, 2)
              }
            ]
          };
        }

        case 'memories': {
          const memoriesList = getMemories(projectId);
          // Omit embeddings from response - they're large and not useful to agents
          const sanitized = memoriesList.map(({ embedding, ...rest }) => rest);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(sanitized, null, 2)
              }
            ]
          };
        }

        case 'context': {
          const state = materializeProject(projectId, false);
          const sessions = getActiveSessions(projectId);
          const todos = Object.values(state.todos);
          const wiki = Object.values(state.wiki);
          const decisions = Object.values(state.decisions);
          const handoffs = state.handoffs.slice(-5); // Last 5 handoffs

          // Build a beautiful unified markdown context packet for zero-click context hydration!
          let markdownContext = `# butler: Unified Project Context [Project: ${projectId}]\n\n`;

          const aliveSessions = sessions.filter(s => s.status === 'alive');
          const staleSessions = sessions.filter(s => s.status === 'stale');

          markdownContext += `## 👥 Active Live Sessions\n`;
          if (aliveSessions.length === 0) {
            markdownContext += `- No active agent sessions detected.\n`;
          } else {
            for (const s of aliveSessions) {
              markdownContext += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${new Date(s.last_heartbeat * 1000).toISOString()}\n`;
            }
          }
          
          if (staleSessions.length > 0) {
            markdownContext += `\n### ⚠️ Stale Sessions (Possibly Disconnected)\n`;
            for (const s of staleSessions) {
              markdownContext += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${new Date(s.last_heartbeat * 1000).toISOString()}\n`;
            }
          }
          markdownContext += `\n`;

          if (handoffs.length > 0) {
            markdownContext += `## 🔄 Recent Session Handoffs\n`;
            for (const h of handoffs) {
              const sourceLabel = (h as any).source === 'agent' ? '📝 Agent-Narrated' : '🤖 System-Generated';
              markdownContext += `### ${sourceLabel} Handoff from ${h.session_id} (${new Date(h.timestamp * 1000).toISOString()})\n`;
              markdownContext += `${h.summary}\n`;
              if (h.payload.completed_todos?.length > 0) {
                markdownContext += `**Completed:** ${h.payload.completed_todos.join(', ')}\n`;
              }
              if (h.payload.pending_todos?.length > 0) {
                markdownContext += `**Pending:** ${h.payload.pending_todos.join(', ')}\n`;
              }
              if (h.payload.recent_decisions?.length > 0) {
                markdownContext += `**Decisions:** ${h.payload.recent_decisions.join(', ')}\n`;
              }
              if (h.payload.rules_added?.length > 0) {
                markdownContext += `**Rules Added:** ${h.payload.rules_added.join(', ')}\n`;
              }
              if (h.payload.wiki_updated?.length > 0) {
                markdownContext += `**Wiki Updated:** ${h.payload.wiki_updated.join(', ')}\n`;
              }
              markdownContext += `\n`;
            }
          }

          markdownContext += `## 🎯 Shared TODOs / Task List\n`;
          const pending = todos.filter(t => t.status === 'pending');
          const completed = todos.filter(t => t.status === 'completed');

          if (pending.length === 0) {
            markdownContext += `- No open tasks. Add one using the \`todo.add\` tool!\n`;
          } else {
            for (const t of pending) {
              const priorityEmoji = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
              markdownContext += `- [ ] [ID ${t.id}] **${t.title}** (Priority: ${priorityEmoji} ${t.priority}, Version: ${t.version})\n`;
            }
          }
          if (completed.length > 0) {
            markdownContext += `\n**Completed Tasks:**\n`;
            for (const t of completed.slice(-5)) { // Show last 5 completed
              markdownContext += `- [x] [ID ${t.id}] **${t.title}** (Version: ${t.version})\n`;
            }
          }
          markdownContext += `\n`;

          markdownContext += `## 📜 Materialized Shared Rules\n`;
          if (state.rules.length === 0) {
            markdownContext += `- No active project coding guidelines. Add one with \`rule.add\`!\n`;
          } else {
            for (const rule of state.rules) {
              markdownContext += `- ${rule}\n`;
            }
          }
          markdownContext += `\n`;

          markdownContext += `## 💡 Recent Architectural Decisions\n`;
          if (decisions.length === 0) {
            markdownContext += `- No formal design decisions recorded yet.\n`;
          } else {
            for (const d of decisions) {
              markdownContext += `### Decision: ${d.title} (ID: ${d.id})\n`;
              markdownContext += `**Context:** ${d.context}\n`;
              markdownContext += `**Outcome/Decision:** ${d.decision}\n\n`;
            }
          }

          markdownContext += `## 📚 Wiki / Knowledge Base\n`;
          if (wiki.length === 0) {
            markdownContext += `- Wiki is currently empty.\n`;
          } else {
            for (const page of wiki) {
              markdownContext += `### Topic: ${page.topic}\n${page.content}\n\n`;
            }
          }

          const rawData = {
            project_id: projectId,
            active_sessions: sessions,
            handoffs,
            open_todos: pending,
            rules: state.rules,
            decisions,
            wiki
          };

          return {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: markdownContext
              },
              {
                uri: `${uri}/raw`,
                mimeType: 'application/json',
                text: JSON.stringify(rawData, null, 2)
              }
            ]
          };
        }

        default:
          throw new McpError(ErrorCode.InvalidRequest, `Unknown resource subpath: ${resourceType}`);
      }
    });
  }

  private setupTools() {
    // 1. List Available Tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'session.register',
            description: 'Register a new active agent session connection.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Unique session identifier (e.g. cursor-1, claude-desktop-2)' },
                client_type: { type: 'string', description: 'Client description (e.g., Cursor, Claude Desktop)' }
              },
              required: ['project_id', 'session_id', 'client_type']
            }
          },
          {
            name: 'session.heartbeat',
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
            name: 'session.disconnect',
            description: 'Gracefully disconnect and shut down an active session connection, immediately flushing a handoff log.',
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
            name: 'todo.add',
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
            name: 'todo.complete',
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
            name: 'wiki.update',
            description: 'Create or update a repository wiki knowledge base document.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Session ID making the update' },
                topic: { type: 'string', description: 'Wiki topic name or heading' },
                content: { type: 'string', description: 'Markdown body text content of page' }
              },
              required: ['project_id', 'session_id', 'topic', 'content']
            }
          },
          {
            name: 'rule.add',
            description: 'Add a persistent development guideline rule that all participating agents should abide by.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Session ID adding the rule' },
                content: { type: 'string', description: 'Coding rule text constraint (e.g. Always write JS files using ESM imports)' }
              },
              required: ['project_id', 'session_id', 'content']
            }
          },
          {
            name: 'decision.record',
            description: 'Log a concrete design or architectural decision (ADR) for cumulative project memory.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Session ID recording decision' },
                decision_id: { type: 'string', description: 'Unique decision tag/id (e.g. ADR-001)' },
                title: { type: 'string', description: 'Title of decision' },
                context: { type: 'string', description: 'Description of constraints or options' },
                decision: { type: 'string', description: 'Resulting choice made' }
              },
              required: ['project_id', 'session_id', 'decision_id', 'title', 'context', 'decision']
            }
          },
          {
            name: 'handoff.create',
            description: 'Explicitly record a session handoff event containing recent accomplishments and open tasks.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Unique session ID logging the handoff' },
                summary: { type: 'string', description: 'Short summary of achievements and state changes' },
                completed_todos: { type: 'array', items: { type: 'string' }, description: 'Lists of tasks completed' },
                pending_todos: { type: 'array', items: { type: 'string' }, description: 'Lists of blocker or future tasks' },
                recent_decisions: { type: 'array', items: { type: 'string' }, description: 'Lists of key architectural designs decided' }
              },
              required: ['project_id', 'session_id', 'summary']
            }
          },
          {
            name: 'memory.store',
            description: 'Store a generic semantic project memory, summary, or observation.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                type: { type: 'string', enum: ['summary', 'decision', 'rule', 'wiki'], description: 'Type of memory metadata' },
                content: { type: 'string', description: 'Content of memory' },
                importance: { type: 'number', minimum: 0, maximum: 1, description: 'Importance rating from 0.0 to 1.0' }
              },
              required: ['project_id', 'type', 'content']
            }
          },
          {
            name: 'memory.search',
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
          }
        ]
      };
    });

    // 2. Handle Tool Call
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments || {};
      
      // Validate required project_id
      if (!args.project_id || typeof args.project_id !== 'string' || args.project_id.trim() === '') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing or invalid required parameter: project_id`
        );
      }
      
      const projectId = String(args.project_id);

      // Validate project ID format
      if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid project_id format. Only alphanumeric characters, underscores, and hyphens are allowed.`
        );
      }
      
      // Validate session_id format if present
      if (args.session_id !== undefined) {
        if (typeof args.session_id !== 'string' || args.session_id.trim() === '') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid session_id: must be a non-empty string`
          );
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(String(args.session_id))) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid session_id format. Only alphanumeric characters, underscores, and hyphens are allowed.`
          );
        }
      }

      try {
        switch (name) {
          case 'session.register': {
            const sess = registerSession(
              projectId,
              String(args.session_id),
              String(args.client_type)
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully registered session ${sess.id} for project ${sess.project_id} (Client: ${sess.client_type}, Status: ${sess.status})`
                }
              ]
            };
          }

          case 'session.heartbeat': {
            processHeartbeat(projectId, String(args.session_id));
            return {
              content: [
                {
                  type: 'text',
                  text: `Heartbeat acknowledged for session ${args.session_id} in project ${projectId}`
                }
              ]
            };
          }

          case 'session.disconnect': {
            gracefulDisconnect(projectId, String(args.session_id));
            // Invalidate cache immediately on graceful disconnect (since it writes events)
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Session ${args.session_id} gracefully disconnected from project ${projectId}. Structured handoff successfully broadcast.`
                }
              ]
            };
          }

          case 'todo.add': {
            validateSession(projectId, String(args.session_id));
            const nextId = getNextSequenceValue(projectId, 'todo');
            
            const priority = args.priority as 'low' | 'medium' | 'high' | undefined;

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'TODO_CREATED',
              {
                todo_id: nextId,
                title: String(args.title),
                priority: priority || 'medium'
              }
            );

            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);

            return {
              content: [
                {
                  type: 'text',
                  text: `Shared TODO successfully created! [ID: ${nextId}] "${args.title}" (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'todo.complete': {
            validateSession(projectId, String(args.session_id));
            const todoId = Number(args.todo_id);
            const reqVersion = Number(args.version);

            // NOTE: This check-then-write pattern is safe only under single-threaded Node.js
            // with synchronous better-sqlite3. If Butler gains concurrent request handling
            // (e.g., HTTP transport), wrap this in db.transaction() to prevent TOCTOU races.
            const state = materializeProject(projectId, false);
            const todo = state.todos[todoId];

            if (!todo) {
              throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
            }

            if (todo.version !== reqVersion) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Version mismatch for TODO ID ${todoId}. Expected version ${todo.version}, but got request version ${reqVersion}. Please fetch resources and try again.`
              );
            }

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'TODO_COMPLETED',
              {
                todo_id: todoId,
                version: reqVersion
              }
            );

            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);

            return {
              content: [
                {
                  type: 'text',
                  text: `Shared TODO ID ${todoId} marked as completed! (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'wiki.update': {
            validateSession(projectId, String(args.session_id));
            const content = String(args.content);
            const topic = String(args.topic);
            
            if (content.length > 65536) {
              throw new McpError(ErrorCode.InvalidParams, 'Wiki content exceeds maximum length of 64KB');
            }
            if (topic.length > 256) {
              throw new McpError(ErrorCode.InvalidParams, 'Wiki topic exceeds maximum length of 256 characters');
            }
            
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'WIKI_UPDATED',
              {
                topic,
                content
              }
            );
            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Wiki topic "${args.topic}" updated. (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'rule.add': {
            validateSession(projectId, String(args.session_id));
            const content = String(args.content);
            
            if (content.length > 4096) {
              throw new McpError(ErrorCode.InvalidParams, 'Rule content exceeds maximum length of 4KB');
            }
            
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'RULE_ADDED',
              {
                content
              }
            );
            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Persistent rule recorded: "${args.content}" (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'decision.record': {
            validateSession(projectId, String(args.session_id));
            const context = String(args.context);
            const decision = String(args.decision);
            
            if (context.length > 8192) {
              throw new McpError(ErrorCode.InvalidParams, 'Decision context exceeds maximum length of 8KB');
            }
            if (decision.length > 8192) {
              throw new McpError(ErrorCode.InvalidParams, 'Decision text exceeds maximum length of 8KB');
            }
            
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'DECISION_RECORDED',
              {
                decision_id: String(args.decision_id),
                title: String(args.title),
                context,
                decision
              }
            );
            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Design decision recorded [ID: ${args.decision_id}] "${args.title}". (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'handoff.create': {
            validateSession(projectId, String(args.session_id));
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'HANDOFF_CREATED',
              {
                session_id: String(args.session_id),
                completed_todos: (args.completed_todos as string[] | undefined) || [],
                pending_todos: (args.pending_todos as string[] | undefined) || [],
                recent_decisions: (args.recent_decisions as string[] | undefined) || [],
                summary: String(args.summary),
                timestamp: Math.floor(Date.now() / 1000)
              }
            );
            updateLastEventSeen(String(args.session_id), event.id);
            invalidateProjectCache(projectId);

            return {
              content: [
                {
                  type: 'text',
                  text: `Session handoff successfully recorded! (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'memory.store': {
            const type = String(args.type);
            const content = String(args.content);
            
            if (content.length > 65536) {
              throw new McpError(ErrorCode.InvalidParams, 'Memory content exceeds maximum length of 64KB');
            }
            
            if (!MEMORY_TYPES.includes(type as any)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid memory type: ${type}. Must be one of ${MEMORY_TYPES.map(t => `'${t}'`).join(', ')}.`
              );
            }

            // Auto-create project if it doesn't exist (like session.register does)
            const db = getDb();
            db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

            const mem = addMemory(
              projectId,
              type as any,
              content,
              undefined,
              args.importance !== undefined ? Number(args.importance) : 0.5
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Memory stored successfully under ID ${mem.id} (Category: ${mem.type}, Importance: ${mem.importance})`
                }
              ]
            };
          }

          case 'memory.search': {
            const results = searchMemories(
              projectId,
              String(args.query),
              undefined,
              args.limit ? Number(args.limit) : 10
            );

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No matching memory logs found in local database.`
                  }
                ]
              };
            }

            let responseText = `### Semantic Search Results for "${args.query}"\n\n`;
            for (const r of results) {
              responseText += `**[ID ${r.memory.id}] ${r.memory.type.toUpperCase()} (Score: ${(r.score * 100).toFixed(1)}%, Keyword Match: ${(r.relevance * 100).toFixed(1)}%, Recency: ${(r.recency * 100).toFixed(1)}%)**\n`;
              responseText += `> ${r.memory.content}\n\n`;
            }

            return {
              content: [
                {
                  type: 'text',
                  text: responseText
                }
              ]
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
        }
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Internal processing error: ${err.message}`
            }
          ]
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    // NOTE: We MUST use console.error for server startup and system logs. 
    // The standard output (stdout) stream MUST remain absolutely clean for JSON-RPC transport protocol packets.
    console.error('Butler MCP Server running on stdio');
  }
}
