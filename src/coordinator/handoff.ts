/**
 * coordinator/handoff.ts
 *
 * Handoff generation logic (Phase 2.1) and quality scoring (Phase 2.4).
 * Extracted from lifecycle.ts to keep each file focused on one concern.
 *
 * Responsibilities:
 *   - generateStructuredHandoff: build a structured diff payload from session events
 *   - computeHandoffQualityScore: score an agent-narrated summary (0.0–1.0)
 */

import { getSessionEvents } from '../events/store.js';
import { materializeProject } from '../events/materializer.js';
import { getSession } from './session.js';
import { now as getCurrentTimestamp } from '../constants.js';

// ─── Handoff Generation ───────────────────────────────────────────────────────

export function generateStructuredHandoff(
  projectId: string,
  sessionId: string,
  type: 'graceful' | 'ungraceful'
): Record<string, any> {
  const sess = getSession(sessionId);
  const sinceEventId = sess ? sess.last_event_seen : 0;

  const sessionEvents = getSessionEvents(projectId, sessionId, sinceEventId);

  const completedTodos: string[] = [];
  const createdTodoIds = new Set<number>();
  const completedTodoIds = new Set<number>();
  const deletedTodoIds = new Set<number>();
  const updatedTodoIds = new Set<number>();
  const rulesAdded: string[] = [];
  const rulesRemoved: string[] = [];
  const decisionsRecorded: string[] = [];
  const wikiUpdated: string[] = [];

  // Pre-populate title lookup from materialized state so labels are human-readable
  const todoTitleById: Record<number, string> = {};
  try {
    const state = materializeProject(projectId, false);
    for (const [id, todo] of Object.entries(state.todos)) {
      todoTitleById[Number(id)] = todo.title;
    }
  } catch (err) {
    console.error('[Butler] Failed to materialize project for handoff titles, falling back to IDs:', err);
  }

  for (const event of sessionEvents) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch (err) {
      console.error(`[Butler] Failed to parse payload for event ID ${event.id} during handoff, skipping:`, err);
      continue;
    }

    switch (event.type) {
      case 'TODO_COMPLETED': {
        const id = Number(payload.todo_id);
        if (!isNaN(id)) {
          completedTodos.push(todoLabel(id, todoTitleById));
          completedTodoIds.add(id);
        }
        break;
      }
      case 'TODO_CREATED': {
        const id = Number(payload.todo_id);
        if (!isNaN(id)) {
          createdTodoIds.add(id);
          if (payload.title) todoTitleById[id] = payload.title;
        }
        break;
      }
      case 'TODO_UPDATED': {
        const id = Number(payload.todo_id);
        if (!isNaN(id)) {
          if (payload.status === 'completed') {
            completedTodos.push(todoLabel(id, todoTitleById));
            completedTodoIds.add(id);
          } else {
            updatedTodoIds.add(id);
          }
          if (payload.title) todoTitleById[id] = payload.title;
        }
        break;
      }
      case 'TODO_DELETED':
        if (payload.todo_id != null) deletedTodoIds.add(Number(payload.todo_id));
        break;
      case 'RULE_ADDED':
        rulesAdded.push(payload.content);
        break;
      case 'RULE_REMOVED':
        rulesRemoved.push(payload.rule_id ?? payload.content ?? 'unknown');
        break;
      case 'DECISION_RECORDED':
        decisionsRecorded.push(`"${payload.title}": ${payload.decision}`);
        break;
      case 'WIKI_UPDATED':
        if (!wikiUpdated.includes(payload.topic)) wikiUpdated.push(payload.topic);
        break;
    }
  }

  const pendingTodoIds = [...createdTodoIds].filter(
    id => !completedTodoIds.has(id) && !deletedTodoIds.has(id)
  );
  const pendingTodos = pendingTodoIds.map(id => todoLabel(id, todoTitleById));

  const diffSummary = buildDiffSummary({
    completedTodos, pendingTodos, deletedTodoIds, updatedTodoIds,
    completedTodoIds, rulesAdded, rulesRemoved, decisionsRecorded, wikiUpdated
  });

  const summary = type === 'graceful'
    ? `Graceful end of session for agent ${sessionId}.`
    : `Session ${sessionId} lost connection (missed heartbeat). Auto-generated continuity marker.`;

  return {
    session_id: sessionId,
    completed_todos: completedTodos,
    pending_todos: pendingTodos,
    deleted_todos: [...deletedTodoIds].map(id => `TODO ID ${id}`),
    recent_decisions: decisionsRecorded,
    rules_added: rulesAdded,
    rules_removed: rulesRemoved,
    wiki_updated: wikiUpdated,
    diff_summary: diffSummary,
    summary,
    timestamp: getCurrentTimestamp()
  };
}

// ─── Handoff Quality Score (Phase 2.4) ───────────────────────────────────────

/**
 * Score an agent-narrated handoff summary on a 0.0–1.0 scale.
 * Criteria: word count, structural indicators (bullets/newlines), domain keywords.
 */
export function computeHandoffQualityScore(summary: string): number {
  if (!summary || summary.trim().length === 0) return 0.0;

  const wordCount = summary.trim().split(/\s+/).length;
  const wordScore = Math.min(wordCount / 20, 1.0); // 20 words = full word score

  const hasStructure = /[\n\-*•]/.test(summary) ? 0.15 : 0.0;
  const hasKeywords = /\b(completed|pending|blocked|decided|fixed|added|removed|updated|todo|issue|note)\b/i
    .test(summary) ? 0.1 : 0.0;

  return Math.min(wordScore * 0.75 + hasStructure + hasKeywords, 1.0);
}

// ─── Internals ────────────────────────────────────────────────────────────────

function todoLabel(id: number, titles: Record<number, string>): string {
  return titles[id] ? `"${titles[id]}" (ID ${id})` : `TODO ID ${id}`;
}

interface DiffParts {
  completedTodos: string[];
  pendingTodos: string[];
  deletedTodoIds: Set<number>;
  updatedTodoIds: Set<number>;
  completedTodoIds: Set<number>;
  rulesAdded: string[];
  rulesRemoved: string[];
  decisionsRecorded: string[];
  wikiUpdated: string[];
}

function buildDiffSummary(p: DiffParts): string {
  const lines: string[] = [];

  if (p.completedTodos.length > 0)
    lines.push(`✅ Completed ${p.completedTodos.length} task(s): ${p.completedTodos.join(', ')}`);
  if (p.pendingTodos.length > 0)
    lines.push(`🔲 Left ${p.pendingTodos.length} task(s) pending: ${p.pendingTodos.join(', ')}`);
  if (p.deletedTodoIds.size > 0)
    lines.push(`🗑️ Deleted ${p.deletedTodoIds.size} task(s): ${[...p.deletedTodoIds].map(id => `ID ${id}`).join(', ')}`);

  const updatedOnly = [...p.updatedTodoIds].filter(
    id => !p.completedTodoIds.has(id) && !p.deletedTodoIds.has(id)
  );
  if (updatedOnly.length > 0)
    lines.push(`✏️ Updated ${updatedOnly.length} task(s): ${updatedOnly.map(id => `ID ${id}`).join(', ')}`);

  if (p.rulesAdded.length > 0)
    lines.push(`📌 Added ${p.rulesAdded.length} rule(s): ${p.rulesAdded.join('; ')}`);
  if (p.rulesRemoved.length > 0)
    lines.push(`❌ Removed ${p.rulesRemoved.length} rule(s)`);
  if (p.decisionsRecorded.length > 0)
    lines.push(`💡 Recorded ${p.decisionsRecorded.length} decision(s): ${p.decisionsRecorded.join('; ')}`);
  if (p.wikiUpdated.length > 0)
    lines.push(`📚 Updated wiki pages: ${p.wikiUpdated.join(', ')}`);

  return lines.length > 0 ? lines.join('\n') : 'No state changes recorded during this session.';
}
