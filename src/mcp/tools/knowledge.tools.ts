/**
 * mcp/tools/knowledge.tools.ts
 *
 * MCP tool definitions and handlers for project knowledge:
 *   wikiupdate, ruleadd, ruleremove, decisionrecord, handoffcreate
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { materializeProject, invalidateProjectCache } from '../../events/materializer.js';
import { appendEvent } from '../../events/store.js';
import { getDb } from '../../db/database.js';
import { validateSession, updateLastEventSeen } from '../../coordinator/lifecycle.js';
import { computeHandoffQualityScore } from '../../coordinator/handoff.js';
import { sanitizeInput, sanitizeTitle } from '../../validation.js';
import { now as getCurrentTimestamp } from '../../constants.js';

export const knowledgeToolDefs = [
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
        content: { type: 'string', description: 'Coding rule text constraint' }
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
  }
] as const;

export async function handleKnowledgeTool(
  name: string,
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'wikiupdate': {
      validateSession(projectId, String(args.session_id));
      const topic = sanitizeTitle(String(args.topic));
      const content = sanitizeInput(String(args.content), 65536);

      const event = appendEvent(projectId, String(args.session_id), 'WIKI_UPDATED', { topic, content });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `Wiki topic "${topic}" updated. (Event ID: ${event.id})` }] };
    }

    case 'ruleadd': {
      validateSession(projectId, String(args.session_id));
      const content = sanitizeInput(String(args.content), 4096);

      const { event, ruleId } = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const duplicate = Object.values(state.rules).find(r => r.content === content);
        if (duplicate) throw new McpError(
          ErrorCode.InvalidRequest,
          `An identical rule already exists with ID ${duplicate.id}. Use ruleremove then ruleadd to update it.`
        );

        const ruleId = randomUUID();
        const event = appendEvent(projectId, String(args.session_id), 'RULE_ADDED', { rule_id: ruleId, content });
        updateLastEventSeen(String(args.session_id), event.id);
        return { event, ruleId };
      })();

      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `Persistent rule recorded with ID ${ruleId}: "${content}" (Event ID: ${event.id})` }] };
    }

    case 'ruleremove': {
      validateSession(projectId, String(args.session_id));
      const ruleId = String(args.rule_id);

      const { event, ruleContent } = getDb().transaction(() => {
        const state = materializeProject(projectId, false);
        const rule = state.rules[ruleId];
        if (!rule) throw new McpError(ErrorCode.InvalidRequest, `Rule with ID "${ruleId}" not found.`);

        const event = appendEvent(projectId, String(args.session_id), 'RULE_REMOVED', { rule_id: ruleId });
        updateLastEventSeen(String(args.session_id), event.id);
        return { event, ruleContent: rule.content };
      })();

      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `Rule "${ruleContent}" (ID: ${ruleId}) removed. (Event ID: ${event.id})` }] };
    }

    case 'decisionrecord': {
      validateSession(projectId, String(args.session_id));
      const decisionId = sanitizeTitle(String(args.decision_id));
      const title = sanitizeTitle(String(args.title));
      const context = sanitizeInput(String(args.context), 8192);
      const decision = sanitizeInput(String(args.decision), 8192);

      const event = appendEvent(projectId, String(args.session_id), 'DECISION_RECORDED', {
        decision_id: decisionId, title, context, decision
      });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);
      return { content: [{ type: 'text', text: `Design decision recorded [ID: ${decisionId}] "${title}". (Event ID: ${event.id})` }] };
    }

    case 'handoffcreate': {
      validateSession(projectId, String(args.session_id));

      const completed_todos = (args.completed_todos as string[] | undefined) ?? [];
      const pending_todos = (args.pending_todos as string[] | undefined) ?? [];
      const recent_decisions = (args.recent_decisions as string[] | undefined) ?? [];
      const summary = sanitizeInput(String(args.summary), 4096);

      if (completed_todos.length > 100) throw new McpError(ErrorCode.InvalidParams, 'completed_todos exceeds 100 items');
      if (pending_todos.length > 100) throw new McpError(ErrorCode.InvalidParams, 'pending_todos exceeds 100 items');
      if (recent_decisions.length > 100) throw new McpError(ErrorCode.InvalidParams, 'recent_decisions exceeds 100 items');

      // Phase 2.4 — quality score feedback
      const score = computeHandoffQualityScore(summary);
      const feedback = score < 0.4
        ? `\n⚠️  Handoff quality: ${Math.round(score * 100)}% — too brief. Add what changed, what's blocked, and key decisions.`
        : score >= 0.8
          ? `\n✅ Handoff quality: ${Math.round(score * 100)}% — well-structured.`
          : `\n📊 Handoff quality: ${Math.round(score * 100)}%.`;

      const event = appendEvent(projectId, String(args.session_id), 'HANDOFF_CREATED', {
        session_id: String(args.session_id),
        completed_todos, pending_todos, recent_decisions, summary,
        timestamp: getCurrentTimestamp()
      });
      updateLastEventSeen(String(args.session_id), event.id);
      invalidateProjectCache(projectId);

      return { content: [{ type: 'text', text: `Session handoff successfully recorded! (Event ID: ${event.id})${feedback}` }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown knowledge tool: ${name}`);
  }
}
