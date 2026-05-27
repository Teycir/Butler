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
import { 
  processHeartbeat, 
  registerSession, 
  getActiveSessions, 
  gracefulDisconnect 
} from '../coordinator/lifecycle.js';
import { searchMemories, addMemory, getMemories } from '../vector/index.js';

export class ButlerMcpServer {
  private server: Server;

  constructor() {
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
            mimeType: 'application/json'
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
      const state = materializeProject(projectId, false);

      switch (resourceType) {
        case 'todos': {
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
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(memoriesList, null, 2)
              }
            ]
          };
        }

        case 'context': {
          const sessions = getActiveSessions(projectId);
          const todos = Object.values(state.todos);
          const wiki = Object.values(state.wiki);
          const decisions = Object.values(state.decisions);

          // Build a beautiful unified markdown context packet for zero-click context hydration!
          let markdownContext = `# butler: Unified Project Context [Project: ${projectId}]\n\n`;

          markdownContext += `## 👥 Active Live Sessions\n`;
          if (sessions.length === 0) {
            markdownContext += `- No active agent sessions detected.\n`;
          } else {
            for (const s of sessions) {
              markdownContext += `- **${s.id}** (${s.client_type}) - Status: \`${s.status}\` (Last Heartbeat: ${new Date(s.last_heartbeat * 1000).toISOString()})\n`;
            }
          }
          markdownContext += `\n`;

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
      const projectId = String(args.project_id);

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
            // Transaction-safe atomic sequential incrementing ID in SQLite
            const nextId = getNextSequenceValue(projectId, 'todo');

            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'TODO_CREATED',
              {
                todo_id: nextId,
                title: String(args.title),
                priority: args.priority || 'medium',
                status: 'pending'
              }
            );

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
            const todoId = Number(args.todo_id);
            const reqVersion = Number(args.version);

            // Fetch state (from cache, O(1)) to confirm optimistic lock version
            const state = materializeProject(projectId, false);
            const todo = state.todos[todoId];

            if (!todo) {
              throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
            }

            // Optimistic lock verification
            if (todo.version !== reqVersion) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Version mismatch for TODO ID ${todoId}. Expected version ${todo.version}, but got request version ${reqVersion}. Please fetch resources and try again.`
              );
            }

            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'TODO_COMPLETED',
              {
                todo_id: todoId,
                version: reqVersion
              }
            );

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
            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'WIKI_UPDATED',
              {
                topic: String(args.topic),
                content: String(args.content)
              }
            );
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
            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'RULE_ADDED',
              {
                content: String(args.content)
              }
            );
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
            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'DECISION_RECORDED',
              {
                decision_id: String(args.decision_id),
                title: String(args.title),
                context: String(args.context),
                decision: String(args.decision)
              }
            );
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
            // Force cache invalidation immediately on write
            invalidateProjectCache(projectId);

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'HANDOFF_CREATED',
              {
                session_id: String(args.session_id),
                completed_todos: args.completed_todos || [],
                pending_todos: args.pending_todos || [],
                recent_decisions: args.recent_decisions || [],
                summary: String(args.summary),
                timestamp: Math.floor(Date.now() / 1000)
              }
            );

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
            // Explicit type validation before passing to SQLite CHECK constraints
            if (!['summary', 'decision', 'rule', 'wiki'].includes(type)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid memory type: ${type}. Must be one of 'summary', 'decision', 'rule', or 'wiki'.`
              );
            }

            const mem = addMemory(
              projectId,
              type as any,
              String(args.content),
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
              responseText += `**[ID ${r.memory.id}] ${r.memory.type.toUpperCase()} (Score: ${(r.score * 100).toFixed(1)}%, Recency: ${(r.recency * 100).toFixed(1)}%, Intent Boost: ${(r.relevance * 100).toFixed(1)}%)**\n`;
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
