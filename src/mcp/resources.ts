/**
 * mcp/resources.ts
 *
 * MCP resource definitions and handlers for Butler.
 * Handles: context, todos, wiki, sessions, memories, diff
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { materializeProject } from '../events/materializer.js';
import { getActiveSessions } from '../coordinator/lifecycle.js';
import { getContextStaleness, getProjectDiff, computeHandoffQualityScore } from '../coordinator/lifecycle.js';
import { getMemories } from '../vector/index.js';
import { searchMemories } from '../vector/index.js';
import { sanitizeMarkdown } from '../validation.js';

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
  }
];

/** Parse a butler:// URI and return { projectId, resourceType, queryParams }. */
function parseResourceUri(uri: string) {
  const match = uri.match(/^butler:\/\/projects\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
  if (!match) {
    throw new McpError(ErrorCode.InvalidRequest, `Unknown or invalid resource URI: ${uri}`);
  }

  const [, projectId, resourceType, queryString] = match;

  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid project_id format. Only alphanumeric characters, underscores, and hyphens are allowed.'
    );
  }

  const queryParams: Record<string, string> = {};
  if (queryString) {
    for (const part of queryString.split('&')) {
      const [k, v] = part.split('=');
      if (k && v !== undefined) queryParams[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }

  return { projectId, resourceType, queryParams };
}

const MEMORY_RELEVANCE_THRESHOLD = 0.3;

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

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource subpath: ${resourceType}`);
  }
}

// ---------------------------------------------------------------------------
// Context resource builder
// ---------------------------------------------------------------------------

function buildContextResource(uri: string, projectId: string) {
  const state = materializeProject(projectId, false);
  const sessions = getActiveSessions(projectId);
  const todos = Object.values(state.todos);
  const wiki = Object.values(state.wiki);
  const decisions = Object.values(state.decisions);
  const handoffs = state.handoffs.slice(-5);
  const staleness = getContextStaleness(projectId);

  // Build implicit memory query from current state signals
  const signals: string[] = [];
  const pendingTodos = todos.filter(t => t.status === 'pending');
  if (pendingTodos.length > 0) signals.push(pendingTodos.map(t => t.title).join(' '));
  if (decisions.length > 0) signals.push(decisions.map(d => d.title).join(' '));
  if (wiki.length > 0) signals.push(wiki.map(w => w.topic).join(' '));
  const implicitQuery = signals.join(' ').trim();
  const relevantMemories = implicitQuery
    ? searchMemories(projectId, implicitQuery, undefined, 5).filter(r => r.score >= MEMORY_RELEVANCE_THRESHOLD)
    : [];

  const md = renderContextMarkdown(projectId, staleness, sessions, handoffs, todos, state, decisions, wiki, relevantMemories);

  const rawData = {
    project_id: projectId,
    staleness,
    last_event_id: state.lastEventId,
    active_sessions: sessions,
    handoffs,
    open_todos: pendingTodos,
    rules: state.rules,
    decisions,
    wiki,
    relevant_memories: relevantMemories.map(r => ({
      id: r.memory.id,
      type: r.memory.type,
      content: r.memory.content,
      importance: r.memory.importance,
      score: r.score,
      created_at: r.memory.created_at
    }))
  };

  return {
    contents: [
      { uri, mimeType: 'text/markdown', text: md },
      { uri: `${uri}/raw`, mimeType: 'application/json', text: JSON.stringify(rawData, null, 2) }
    ]
  };
}

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return 'no live session';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function renderContextMarkdown(
  projectId: string,
  staleness: ReturnType<typeof getContextStaleness>,
  sessions: ReturnType<typeof getActiveSessions>,
  handoffs: any[],
  todos: any[],
  state: any,
  decisions: any[],
  wiki: any[],
  relevantMemories: any[]
): string {
  let md = `# butler: Unified Project Context [Project: ${projectId}]\n\n`;

  const ageStr = formatAge(staleness.context_age_seconds);
  const freshnessIcon = staleness.has_live_session ? '🟢' : '🔴';
  md += `> ${freshnessIcon} **Context freshness:** Last live heartbeat ${ageStr}`;
  if (!staleness.has_live_session) md += ` — no agent is currently connected`;
  md += `\n\n`;

  const aliveSessions = sessions.filter(s => s.status === 'alive');
  const staleSessions = sessions.filter(s => s.status === 'stale');

  md += `## 👥 Active Live Sessions\n`;
  if (aliveSessions.length === 0) {
    md += `- No active agent sessions detected.\n`;
  } else {
    for (const s of aliveSessions) {
      md += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${new Date(s.last_heartbeat * 1000).toISOString()}\n`;
    }
  }
  if (staleSessions.length > 0) {
    md += `\n### ⚠️ Stale Sessions (Possibly Disconnected)\n`;
    for (const s of staleSessions) {
      md += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${new Date(s.last_heartbeat * 1000).toISOString()}\n`;
    }
  }
  md += `\n`;

  if (handoffs.length > 0) {
    md += `## 🔄 Recent Session Handoffs\n`;
    for (const h of handoffs) {
      const sourceLabel = h.source === 'agent' ? '📝 Agent-Narrated' : '🤖 System-Generated';
      const qualityScore = h.source === 'agent' ? computeHandoffQualityScore(h.summary) : null;
      const qualityStr = qualityScore != null
        ? ` — Quality: ${Math.round(qualityScore * 100)}%${qualityScore < 0.4 ? ' ⚠️ low' : qualityScore >= 0.8 ? ' ✅' : ''}`
        : '';
      md += `### ${sourceLabel} Handoff from ${h.session_id} (${new Date(h.timestamp * 1000).toISOString()})${qualityStr}\n`;
      md += `> ${sanitizeMarkdown(h.summary).replace(/\n/g, '\n> ')}\n`;
      if (h.payload?.diff_summary && h.payload.diff_summary !== h.summary) {
        md += `\n**Changes this session:**\n`;
        for (const line of h.payload.diff_summary.split('\n')) md += `> ${sanitizeMarkdown(line)}\n`;
      }
      if (h.payload?.completed_todos?.length > 0) md += `**Completed:** ${h.payload.completed_todos.map(sanitizeMarkdown).join(', ')}\n`;
      if (h.payload?.pending_todos?.length > 0) md += `**Pending:** ${h.payload.pending_todos.map(sanitizeMarkdown).join(', ')}\n`;
      if (h.payload?.recent_decisions?.length > 0) md += `**Decisions:** ${h.payload.recent_decisions.map(sanitizeMarkdown).join(', ')}\n`;
      if (h.payload?.rules_added?.length > 0) md += `**Rules Added:** ${h.payload.rules_added.map(sanitizeMarkdown).join(', ')}\n`;
      if (h.payload?.wiki_updated?.length > 0) md += `**Wiki Updated:** ${h.payload.wiki_updated.map(sanitizeMarkdown).join(', ')}\n`;
      md += `\n`;
    }
  }

  const pending = todos.filter(t => t.status === 'pending');
  const completed = todos.filter(t => t.status === 'completed');

  md += `## 🎯 Shared TODOs / Task List\n`;
  if (pending.length === 0) {
    md += `- No open tasks. Add one using the \`todoadd\` tool!\n`;
  } else {
    for (const t of pending) {
      const priorityEmoji = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
      const claimNote = t.claimed_by ? ` 🔒 claimed by \`${t.claimed_by}\`` : '';
      md += `- [ ] [ID ${t.id}] **${sanitizeMarkdown(t.title)}** (Priority: ${priorityEmoji} ${t.priority}, Version: ${t.version}${claimNote})\n`;
    }
  }
  if (completed.length > 0) {
    md += `\n**Completed Tasks:**\n`;
    for (const t of completed.slice(-5)) {
      md += `- [x] [ID ${t.id}] **${sanitizeMarkdown(t.title)}** (Version: ${t.version})\n`;
    }
    if (completed.length > 5) {
      md += `\n_...and ${completed.length - 5} more completed task(s)._\n`;
    }
  }
  md += `\n`;

  md += `## 📜 Materialized Shared Rules\n`;
  const rulesList = Object.values(state.rules) as any[];
  if (rulesList.length === 0) {
    md += `- No active project coding guidelines. Add one with \`ruleadd\`!\n`;
  } else {
    for (const rule of rulesList) {
      md += `- [${rule.id}] ${sanitizeMarkdown(rule.content)}\n`;
    }
  }
  md += `\n`;

  md += `## 💡 Recent Architectural Decisions\n`;
  if (decisions.length === 0) {
    md += `- No formal design decisions recorded yet.\n`;
  } else {
    for (const d of decisions) {
      md += `### Decision: ${sanitizeMarkdown(d.title)} (ID: ${d.id})\n`;
      md += `**Context:** ${sanitizeMarkdown(d.context)}\n`;
      md += `**Outcome/Decision:** ${sanitizeMarkdown(d.decision)}\n\n`;
    }
  }

  md += `## 📚 Wiki / Knowledge Base\n`;
  if (wiki.length === 0) {
    md += `- Wiki is currently empty.\n`;
  } else {
    for (const page of wiki) {
      md += `### Topic: ${sanitizeMarkdown(page.topic)}\n${sanitizeMarkdown(page.content)}\n\n`;
    }
  }

  if (relevantMemories.length > 0) {
    md += `\n## 🧠 Relevant Memory\n`;
    md += `_Automatically surfaced from project memory based on current context._\n\n`;
    for (const r of relevantMemories) {
      const typeLabel = r.memory.type.charAt(0).toUpperCase() + r.memory.type.slice(1);
      const recencyDays = Math.floor((Date.now() / 1000 - r.memory.created_at) / 86400);
      const recencyStr = recencyDays === 0 ? 'today' : recencyDays === 1 ? '1 day ago' : `${recencyDays} days ago`;
      md += `- **[${typeLabel}]** ${sanitizeMarkdown(r.memory.content)} _(importance: ${r.memory.importance.toFixed(1)}, ${recencyStr})_\n`;
    }
    md += `\n`;
  }

  // Phase 3.1 — conflicts
  if (state.conflicts && state.conflicts.length > 0) {
    md += `\n## ⚡ Recent Coordination Conflicts\n`;
    md += `_These TODOs had concurrent writes from multiple sessions recently._\n\n`;
    for (const c of state.conflicts.slice(-5)) {
      md += `- **TODO ID ${c.todo_id}** — ${c.conflict_type.replace('_', ' ')} detected between sessions \`${c.detected_by_session}\` and \`${c.conflicting_session_id}\` (${new Date(c.detected_at * 1000).toISOString()})\n`;
    }
    md += `\n`;
  }

  // Phase 3.3 — messages addressed to a given session (shown to all for now; agents filter by session_id)
  const recentMessages = state.messages ? state.messages.slice(-10) : [];
  if (recentMessages.length > 0) {
    md += `\n## 📬 Direct Messages\n`;
    for (const m of recentMessages) {
      md += `- **To \`${m.to_session_id}\`** from \`${m.from_session_id}\` (${new Date(m.sent_at * 1000).toISOString()}): ${sanitizeMarkdown(m.content)}\n`;
    }
    md += `\n`;
  }

  // Phase 3.4 — broadcasts
  const recentBroadcasts = state.broadcasts ? state.broadcasts.slice(-5) : [];
  if (recentBroadcasts.length > 0) {
    md += `\n## 📢 Broadcasts\n`;
    for (const b of recentBroadcasts) {
      md += `- **\`${b.from_session_id}\`** (${new Date(b.sent_at * 1000).toISOString()}): ${sanitizeMarkdown(b.content)}\n`;
    }
    md += `\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// Diff resource builder
// ---------------------------------------------------------------------------

function buildDiffResource(uri: string, projectId: string, queryParams: Record<string, string>) {
  const sinceEventId = queryParams.since ? parseInt(queryParams.since, 10) : 0;
  if (isNaN(sinceEventId) || sinceEventId < 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid 'since' parameter — must be a non-negative integer event ID`
    );
  }

  const diffEntries = getProjectDiff(projectId, sinceEventId);
  const grouped: Record<string, typeof diffEntries> = {};
  for (const entry of diffEntries) {
    const key = entry.type.split('_')[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }

  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        project_id: projectId,
        since_event_id: sinceEventId,
        total_changes: diffEntries.length,
        grouped,
        entries: diffEntries
      }, null, 2)
    }]
  };
}
