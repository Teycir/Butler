import { getDb } from '../../db/database.js';
import { now as getCurrentTimestamp, MEMORY_RELEVANCE_THRESHOLD } from '../../constants.js';
import { materializeProject } from '../../events/materializer.js';
import { getActiveSessions, getContextStaleness, computeHandoffQualityScore } from '../../coordinator/lifecycle.js';
import { searchMemories } from '../../vector/index.js';
import { escapeMarkdownForRender } from '../../validation.js';
import { formatAge, formatRecencyDays, formatTimestamp } from '../../lib/format.js';

// Cache for context rendering to prevent redundant materialize + TF-IDF queries
interface CachedContext {
  lastEventId: number;
  renderedAt: number; // unix timestamp in seconds
  response: {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  };
}
const contextCache = new Map<string, CachedContext>();

export function buildContextResource(uri: string, projectId: string) {
  const db = getDb();
  const now = getCurrentTimestamp();

  // 1. Get the latest event ID from the database quickly
  const eventRow = db.prepare('SELECT MAX(id) as max_id FROM events WHERE project_id = ?').get(projectId) as any;
  const currentLastEventId = eventRow?.max_id ? Number(eventRow.max_id) : 0;

  // 2. Check cache (cache for 15 seconds if lastEventId matches)
  const cached = contextCache.get(projectId);
  if (cached && cached.lastEventId === currentLastEventId && (now - cached.renderedAt) < 15) {
    return cached.response;
  }

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

  const response = {
    contents: [
      { uri, mimeType: 'text/markdown', text: md },
      { uri: `${uri}/raw`, mimeType: 'application/json', text: JSON.stringify(rawData, null, 2) }
    ]
  };

  contextCache.set(projectId, {
    lastEventId: currentLastEventId,
    renderedAt: now,
    response
  });

  // Evict the oldest entry if the cache size exceeds 100 projects
  if (contextCache.size > 100) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey !== undefined) {
      contextCache.delete(oldestKey);
    }
  }

  return response;
}

// formatAge imported from format.ts

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

  const ageStr = formatAge(staleness.context_age_seconds, 'no live session');
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
      md += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${formatTimestamp(s.last_heartbeat)}\n`;
    }
  }
  if (staleSessions.length > 0) {
    md += `\n### ⚠️ Stale Sessions (Possibly Disconnected)\n`;
    for (const s of staleSessions) {
      md += `- **${s.id}** (${s.client_type}) - Last Heartbeat: ${formatTimestamp(s.last_heartbeat)}\n`;
    }
  }
  md += `\n`;

  if (handoffs.length > 0) {
    md += `## 🔄 Recent Session Handoffs\n`;
    for (const h of handoffs) {
      const sourceLabel = h.source === 'agent' ? '📝 Agent-Narrated' : '🤖 System-Generated';
      const qualityScore = h.source === 'agent' ? computeHandoffQualityScore(h.summary) : null;
      const qualityStr = qualityScore != null
        ? ` — Quality: ${qualityScore < 0.4 ? 'low ⚠️' : qualityScore >= 0.8 ? 'excellent ✅' : 'satisfactory'}`
        : '';
      md += `### ${sourceLabel} Handoff from ${h.session_id} (${formatTimestamp(h.timestamp)})${qualityStr}\n`;
      md += `> ${escapeMarkdownForRender(h.summary).replace(/\n/g, '\n> ')}\n`;
      if (h.payload?.diff_summary && h.payload.diff_summary !== h.summary) {
        md += `\n**Changes this session:**\n`;
        for (const line of h.payload.diff_summary.split('\n')) md += `> ${escapeMarkdownForRender(line)}\n`;
      }
      if (h.payload?.completed_todos?.length > 0) md += `**Completed:** ${h.payload.completed_todos.map(escapeMarkdownForRender).join(', ')}\n`;
      if (h.payload?.pending_todos?.length > 0) md += `**Pending:** ${h.payload.pending_todos.map(escapeMarkdownForRender).join(', ')}\n`;
      if (h.payload?.recent_decisions?.length > 0) md += `**Decisions:** ${h.payload.recent_decisions.map(escapeMarkdownForRender).join(', ')}\n`;
      if (h.payload?.rules_added?.length > 0) md += `**Rules Added:** ${h.payload.rules_added.map(escapeMarkdownForRender).join(', ')}\n`;
      if (h.payload?.wiki_updated?.length > 0) md += `**Wiki Updated:** ${h.payload.wiki_updated.map(escapeMarkdownForRender).join(', ')}\n`;
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
      md += `- [ ] [ID ${t.id}] **${escapeMarkdownForRender(t.title)}** (Priority: ${priorityEmoji} ${t.priority}, Version: ${t.version}${claimNote})\n`;
    }
  }
  if (completed.length > 0) {
    md += `\n**Completed Tasks:**\n`;
    for (const t of completed.slice(-5)) {
      md += `- [x] [ID ${t.id}] **${escapeMarkdownForRender(t.title)}** (Version: ${t.version})\n`;
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
      md += `- [${rule.id}] ${escapeMarkdownForRender(rule.content)}\n`;
    }
  }
  md += `\n`;

  md += `## 💡 Recent Architectural Decisions\n`;
  if (decisions.length === 0) {
    md += `- No formal design decisions recorded yet.\n`;
  } else {
    for (const d of decisions) {
      md += `### Decision: ${escapeMarkdownForRender(d.title)} (ID: ${d.id})\n`;
      md += `**Context:** ${escapeMarkdownForRender(d.context)}\n`;
      md += `**Outcome/Decision:** ${escapeMarkdownForRender(d.decision)}\n\n`;
    }
  }

  md += `## 📚 Wiki / Knowledge Base\n`;
  if (wiki.length === 0) {
    md += `- Wiki is currently empty.\n`;
  } else {
    for (const page of wiki) {
      md += `### Topic: ${escapeMarkdownForRender(page.topic)}\n${escapeMarkdownForRender(page.content)}\n\n`;
    }
  }

  if (relevantMemories.length > 0) {
    md += `\n## 🧠 Relevant Memory\n`;
    md += `_Automatically surfaced from project memory based on current context._\n\n`;
    for (const r of relevantMemories) {
      const typeLabel = r.memory.type.charAt(0).toUpperCase() + r.memory.type.slice(1);
      const recencyStr = formatRecencyDays(r.memory.created_at);
      md += `- **[${typeLabel}]** ${escapeMarkdownForRender(r.memory.content)} _(importance: ${r.memory.importance.toFixed(1)}, ${recencyStr})_\n`;
    }
    md += `\n`;
  }

  // Phase 3.1 — conflicts
  if (state.conflicts && state.conflicts.length > 0) {
    md += `\n## ⚡ Recent Coordination Conflicts\n`;
    md += `_These TODOs had concurrent writes from multiple sessions recently._\n\n`;
    for (const c of state.conflicts.slice(-5)) {
      md += `- **TODO ID ${c.todo_id}** — ${c.conflict_type.replace('_', ' ')} detected between sessions \`${c.detected_by_session}\` and \`${c.conflicting_session_id}\` (${formatTimestamp(c.detected_at)})\n`;
      if (c.hint) {
        md += `  💡 *Resolution Hint:* ${c.hint}\n`;
      }
    }
    md += `\n`;
  }

  // Phase 3.3 — messages
  const recentMessages = state.messages ? state.messages.slice(-10) : [];
  if (recentMessages.length > 0) {
    md += `\n## 📬 Direct Messages\n`;
    for (const m of recentMessages) {
      md += `- **To \`${m.to_session_id}\`** from \`${m.from_session_id}\` (${formatTimestamp(m.sent_at)}): ${escapeMarkdownForRender(m.content)}\n`;
    }
    md += `\n`;
  }

  // Phase 3.4 — broadcasts
  const recentBroadcasts = state.broadcasts ? state.broadcasts.slice(-5) : [];
  if (recentBroadcasts.length > 0) {
    md += `\n## 📢 Broadcasts\n`;
    for (const b of recentBroadcasts) {
      md += `- **\`${b.from_session_id}\`** (${formatTimestamp(b.sent_at)}): ${escapeMarkdownForRender(b.content)}\n`;
    }
    md += `\n`;
  }

  return md;
}
