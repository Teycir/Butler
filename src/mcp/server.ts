import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'crypto';
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
import { searchMemories, addMemory, getMemories, deleteMemory } from '../vector/index.js';
import { validateProjectId, validateSessionId, sanitizeInput, sanitizeTitle } from '../validation.js';

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
        },
        instructions: `
## Butler: Agent Coordination Protocol

You are connected to Butler, a persistent shared memory layer for multi-agent collaboration.
Your role is not just to read context — you are an active contributor to shared knowledge.
Every agent that connects both consumes and feeds this brain. That is what makes it useful.

---

## On Startup — Silent, Zero Friction

### Step 1 — Discover projects
Call \`projectlist\` with no arguments.

### Step 2 — Register your session
- **1 project**: Call \`sessionregister\` immediately. No questions.
- **0 projects**: Ask the user for a project name (one question), then \`sessionregister\`.
- **2+ projects**: Show the list, ask which one, then \`sessionregister\`.

Use:
- \`project_id\`: the project's id
- \`session_id\`: auto-generated, e.g. "<client-name>-<random-4-chars>"
- \`client_type\`: your tool/client name (e.g. "Claude", "Kiro", "Cursor")

### Step 3 — Load and internalize context
Read \`butler://projects/{project_id}/context\` and silently absorb:
- Who else is connected (active sessions)
- Open TODOs — your shared task queue
- Rules — guidelines every agent must follow
- Recent decisions and wiki knowledge

### Step 4 — Heartbeat
Call \`sessionheartbeat\` every 15 seconds for the duration of the session.

---

## During Work — Be an Active Contributor

Butler is only as useful as what agents put into it. Contribute proactively:

- **Made an architectural or design decision?** → \`decisionrecord\` immediately.
  Don't wait. Other agents may be working in parallel and need to know.

- **Learned something project-relevant?** (a pattern, a gotcha, how something works, a constraint) → \`wikiupdate\`.
  If you had to figure it out, the next agent shouldn't have to.

- **Completed a task?** → \`todocomplete\`. If you started something new → \`todoadd\`.
  Keep the shared task queue honest and current.

- **Discovered a rule that should apply to all agents?** (naming conventions, forbidden patterns, required approaches) → \`ruleadd\`.
  Rules are standing instructions for every agent, forever.

- **Noticed something another agent should know right now?** → Write it.
  Don't assume they'll figure it out. The shared brain only works if you feed it.

---

## On Disconnect — Leave a Real Handoff

Before disconnecting, always call \`handoffcreate\` with a meaningful summary:
- What you accomplished
- What is still pending or blocked
- Key decisions made during this session
- Anything the next agent needs to know to pick up cleanly

Then call \`sessiondisconnect\`.

A blank or minimal handoff wastes the next agent's time. Write the handoff you would want to receive.

---

**You are not a passive reader of shared context. You are a contributor to it.
The quality of collaboration depends on what every agent puts in.**
        `.trim()
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
              markdownContext += `> ${h.summary.replace(/\n/g, '\n> ')}\n`;
              if (h.payload.completed_todos?.length > 0) {
                markdownContext += `**Completed:** ${h.payload.completed_todos.join(', ')}\n`;
              }
              if (h.payload.pending_todos?.length > 0) {
                markdownContext += `**Pending:** ${h.payload.pending_todos.join(', ')}\n`;
              }
              if (h.payload.recent_decisions?.length > 0) {
                markdownContext += `**Decisions:** ${h.payload.recent_decisions.join(', ')}\n`;
              }
              if (h.payload.rules_added && h.payload.rules_added.length > 0) {
                markdownContext += `**Rules Added:** ${h.payload.rules_added.join(', ')}\n`;
              }
              if (h.payload.wiki_updated && h.payload.wiki_updated.length > 0) {
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
            if (completed.length > 5) {
              markdownContext += `\n_...and ${completed.length - 5} more completed task(s)._\n`;
            }
          }
          markdownContext += `\n`;

          markdownContext += `## 📜 Materialized Shared Rules\n`;
          const rulesList = Object.values(state.rules);
          if (rulesList.length === 0) {
            markdownContext += `- No active project coding guidelines. Add one with \`rule.add\`!\n`;
          } else {
            for (const rule of rulesList) {
              markdownContext += `- [${rule.id}] ${rule.content}\n`;
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
            name: 'sessionregister',
            description: 'Register a new active agent session connection.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Unique session identifier. Must contain only alphanumeric characters, underscores, and hyphens (e.g. cursor-1, claude-desktop-2, kiro_cli_4)' },
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
          },
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
            name: 'wikiupdate',
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
            name: 'ruleadd',
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
            name: 'ruleremove',
            description: 'Remove a persistent development guideline rule by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                session_id: { type: 'string', description: 'Session ID removing the rule' },
                rule_id: { type: 'string', description: 'UUID of the rule to remove' }
              },
              required: ['project_id', 'session_id', 'rule_id']
            }
          },
          {
            name: 'todolist',
            description: 'List all active TODOs in the project. Alternative to reading the butler://projects/{id}/todos resource.',
            inputSchema: {
              type: 'object',
              properties: {
                project_id: { type: 'string', description: 'Unique project identifier' },
                status: { type: 'string', enum: ['pending', 'completed', 'all'], description: 'Filter by status (default: pending)' }
              },
              required: ['project_id']
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
          },
          {
            name: 'decisionrecord',
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
            name: 'handoffcreate',
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
            name: 'memorystore',
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
          }
        ]
      };
    });

    // 2. Handle Tool Call
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments || {};

      // project.list is the only tool that does not target a specific project
      if (name === 'projectlist') {
        try {
          const db = getDb();
          const rows = db.prepare(
            'SELECT id, name, created_at FROM projects ORDER BY created_at ASC'
          ).all() as Array<{ id: string; name: string; created_at: number }>;

          if (rows.length === 0) {
            return {
              content: [{ type: 'text', text: 'No projects found in the Butler database. Call `sessionregister` with project_id, session_id, and client_type to get started.' }]
            };
          }
          const projectList = rows.map(r => ({
            id: r.id,
            name: r.name,
            created_at: new Date(r.created_at * 1000).toISOString()
          }));
          return { content: [{ type: 'text', text: JSON.stringify(projectList, null, 2) }] };
        } catch (err: any) {
          if (err instanceof McpError) throw err;
          return { isError: true, content: [{ type: 'text', text: `Internal error: ${err.message}` }] };
        }
      }
      
      // Validate required project_id
      if (!args.project_id || typeof args.project_id !== 'string' || args.project_id.trim() === '') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing or invalid required parameter: project_id`
        );
      }
      
      const projectId = String(args.project_id);
      validateProjectId(projectId);
      
      // Validate session_id format if present
      if (args.session_id !== undefined) {
        if (typeof args.session_id !== 'string' || args.session_id.trim() === '') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid session_id: must be a non-empty string`
          );
        }
        validateSessionId(String(args.session_id));
      }

      try {
        switch (name) {
          case 'sessionregister': {
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

          case 'sessionheartbeat': {
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

          case 'sessiondisconnect': {
            gracefulDisconnect(projectId, String(args.session_id));
            return {
              content: [
                {
                  type: 'text',
                  text: `Session ${args.session_id} gracefully disconnected from project ${projectId}. Structured handoff successfully broadcast.`
                }
              ]
            };
          }

          case 'todoadd': {
            validateSession(projectId, String(args.session_id));
            const nextId = getNextSequenceValue(projectId, 'todo');
            
            const title = sanitizeTitle(String(args.title));
            const priority = args.priority as 'low' | 'medium' | 'high' | undefined;

            const event = appendEvent(
              projectId,
              String(args.session_id),
              'TODO_CREATED',
              {
                todo_id: nextId,
                title,
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

          case 'todocomplete': {
            validateSession(projectId, String(args.session_id));
            const todoId = Number(args.todo_id);
            const reqVersion = Number(args.version);

            const db = getDb();
            const completeTx = db.transaction(() => {
              const state = materializeProject(projectId, false);
              const todo = state.todos[todoId];

              if (!todo) {
                throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} not found.`);
              }

              if (todo.status === 'completed') {
                throw new McpError(ErrorCode.InvalidRequest, `TODO task ID ${todoId} is already completed.`);
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
              return event;
            });

            const event = completeTx();
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

          case 'todoupdate': {
            validateSession(projectId, String(args.session_id));
            const todoId = Number(args.todo_id);
            const reqVersion = Number(args.version);

            const db = getDb();
            const updateTx = db.transaction(() => {
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
                'TODO_UPDATED',
                {
                  todo_id: todoId,
                  title: args.title !== undefined ? sanitizeTitle(String(args.title)) : undefined,
                  priority: args.priority as 'low' | 'medium' | 'high' | undefined,
                  status: args.status as 'pending' | 'completed' | undefined
                }
              );

              updateLastEventSeen(String(args.session_id), event.id);
              return event;
            });

            const event = updateTx();
            invalidateProjectCache(projectId);

            return {
              content: [
                {
                  type: 'text',
                  text: `TODO ID ${todoId} updated! (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'tododelete': {
            validateSession(projectId, String(args.session_id));
            const todoId = Number(args.todo_id);
            const reqVersion = Number(args.version);

            const db = getDb();
            const deleteTx = db.transaction(() => {
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
                'TODO_DELETED',
                {
                  todo_id: todoId
                }
              );

              updateLastEventSeen(String(args.session_id), event.id);
              return event;
            });

            const event = deleteTx();
            invalidateProjectCache(projectId);

            return {
              content: [
                {
                  type: 'text',
                  text: `TODO ID ${todoId} deleted! (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'wikiupdate': {
            validateSession(projectId, String(args.session_id));
            const topic = sanitizeTitle(String(args.topic));
            const content = sanitizeInput(String(args.content), 65536);
            
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

          case 'ruleadd': {
            validateSession(projectId, String(args.session_id));
            const content = sanitizeInput(String(args.content), 4096);

            const db = getDb();
            // Wrap in transaction: check-then-write to prevent duplicate rules racing in.
            const addRuleTx = db.transaction(() => {
              const state = materializeProject(projectId, false);
              // Prevent adding an identical rule body twice (idempotency guard)
              const duplicate = Object.values(state.rules).find(r => r.content === content);
              if (duplicate) {
                throw new McpError(
                  ErrorCode.InvalidRequest,
                  `An identical rule already exists with ID ${duplicate.id}. Use ruleremove then ruleadd to update it.`
                );
              }

              const ruleId = randomUUID();
              const event = appendEvent(
                projectId,
                String(args.session_id),
                'RULE_ADDED',
                { rule_id: ruleId, content }
              );
              updateLastEventSeen(String(args.session_id), event.id);
              return { event, ruleId };
            });

            const { event, ruleId } = addRuleTx();
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Persistent rule recorded with ID ${ruleId}: "${content}" (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'ruleremove': {
            validateSession(projectId, String(args.session_id));
            const ruleId = String(args.rule_id);

            const db = getDb();
            // Wrap in transaction: verify rule exists before appending removal event.
            const removeRuleTx = db.transaction(() => {
              const state = materializeProject(projectId, false);
              const rule = state.rules[ruleId];
              if (!rule) {
                throw new McpError(ErrorCode.InvalidRequest, `Rule with ID "${ruleId}" not found.`);
              }

              const event = appendEvent(
                projectId,
                String(args.session_id),
                'RULE_REMOVED',
                { rule_id: ruleId }
              );
              updateLastEventSeen(String(args.session_id), event.id);
              return { event, ruleContent: rule.content };
            });

            const { event, ruleContent } = removeRuleTx();
            invalidateProjectCache(projectId);
            return {
              content: [
                {
                  type: 'text',
                  text: `Rule "${ruleContent}" (ID: ${ruleId}) removed. (Event ID: ${event.id})`
                }
              ]
            };
          }

          case 'decisionrecord': {
            validateSession(projectId, String(args.session_id));
            const decisionId = sanitizeTitle(String(args.decision_id));
            const title = sanitizeTitle(String(args.title));
            const context = sanitizeInput(String(args.context), 8192);
            const decision = sanitizeInput(String(args.decision), 8192);
            
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'DECISION_RECORDED',
              {
                decision_id: decisionId,
                title,
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

          case 'handoffcreate': {
            validateSession(projectId, String(args.session_id));
            
            const completed_todos = (args.completed_todos as string[] | undefined) || [];
            const pending_todos = (args.pending_todos as string[] | undefined) || [];
            const recent_decisions = (args.recent_decisions as string[] | undefined) || [];
            const summary = sanitizeInput(String(args.summary), 4096);
            
            if (completed_todos.length > 100) {
              throw new McpError(ErrorCode.InvalidParams, 'completed_todos exceeds maximum length of 100 items');
            }
            if (pending_todos.length > 100) {
              throw new McpError(ErrorCode.InvalidParams, 'pending_todos exceeds maximum length of 100 items');
            }
            if (recent_decisions.length > 100) {
              throw new McpError(ErrorCode.InvalidParams, 'recent_decisions exceeds maximum length of 100 items');
            }
            
            const event = appendEvent(
              projectId,
              String(args.session_id),
              'HANDOFF_CREATED',
              {
                session_id: String(args.session_id),
                completed_todos,
                pending_todos,
                recent_decisions,
                summary,
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

            // Validate session if provided
            if (args.session_id) {
              validateSession(projectId, String(args.session_id));
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

          case 'memorysearch': {
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

          case 'todolist': {
            const state = materializeProject(projectId, false);
            const todos = Object.values(state.todos);
            const filterStatus = args.status as string | undefined;

            const filtered = (!filterStatus || filterStatus === 'all')
              ? todos
              : todos.filter(t => t.status === filterStatus);

            // Sort: pending first by id, then completed
            const sorted = filtered.sort((a, b) => {
              if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
              return a.id - b.id;
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(sorted, null, 2)
                }
              ]
            };
          }

          case 'memorydelete': {
            const memoryId = Number(args.memory_id);
            if (!Number.isInteger(memoryId) || memoryId <= 0) {
              throw new McpError(ErrorCode.InvalidParams, 'memory_id must be a positive integer');
            }

            // Validate session if provided (memory.delete doesn't require a session, matching memory.store)
            if (args.session_id) {
              validateSession(projectId, String(args.session_id));
            }

            const db = getDb();
            const deleteTx = db.transaction(() => {
              // Confirm the memory exists and belongs to this project before logging the event
              const row = db.prepare('SELECT id FROM memories WHERE id = ? AND project_id = ?')
                .get(memoryId, projectId);
              if (!row) {
                throw new McpError(
                  ErrorCode.InvalidRequest,
                  `Memory ID ${memoryId} not found in project ${projectId}.`
                );
              }
              // Hard-delete from the memories table (memories are not event-sourced state)
              deleteMemory(projectId, memoryId);
              // Append audit event so there is a record of the deletion in the event log
              const sessionIdForEvent = args.session_id ? String(args.session_id) : 'system';
              appendEvent(projectId, sessionIdForEvent, 'MEMORY_DELETED', { memory_id: memoryId });
            });

            deleteTx();
            return {
              content: [
                {
                  type: 'text',
                  text: `Memory ID ${memoryId} deleted from project ${projectId}.`
                }
              ]
            };
          }

          case 'projectlist': {
            // This case is unreachable — projectlist is handled before the switch
            // because it does not require a project_id. Left as a safety fallback.
            throw new McpError(ErrorCode.InternalError, 'projectlist should have been handled before this switch.');
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
