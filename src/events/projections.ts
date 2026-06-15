import { EventRecord } from './types.js';
import {
  HANDOFF_HISTORY_LIMIT,
  CONFLICT_HISTORY_LIMIT,
  MESSAGE_HISTORY_LIMIT,
  BROADCAST_HISTORY_LIMIT
} from '../constants.js';
import { ProjectState } from './materializer.js';

export function projectEvent(state: ProjectState, event: EventRecord): ProjectState {
  const updatedState = {
    todos: { ...state.todos },
    wiki: { ...state.wiki },
    rules: { ...state.rules },
    decisions: { ...state.decisions },
    handoffs: [...state.handoffs],
    conflicts: [...state.conflicts],
    messages: [...state.messages],
    broadcasts: [...state.broadcasts],
    lastEventId: event.id
  };

  let payload: any;
  try {
    payload = JSON.parse(event.payload);
  } catch (e) {
    console.error(`Failed to parse payload for event ID ${event.id}:`, e);
    return state;
  }

  switch (event.type) {
    case 'TODO_CREATED': {
      const todoId = Number(payload.todo_id);
      updatedState.todos[todoId] = {
        id: todoId,
        title: payload.title,
        priority: payload.priority || 'medium',
        status: 'pending',
        version: 1,
        created_by: event.session_id,
        updated_at: event.created_at,
        updated_by: event.session_id
      };
      break;
    }

    case 'TODO_UPDATED': {
      const todoId = Number(payload.todo_id);
      const existing = updatedState.todos[todoId];
      if (existing) {
        updatedState.todos[todoId] = {
          ...existing,
          title: payload.title !== undefined ? payload.title : existing.title,
          priority: payload.priority !== undefined ? payload.priority : existing.priority,
          status: payload.status !== undefined ? payload.status : existing.status,
          version: existing.version + 1,
          updated_at: event.created_at,
          updated_by: event.session_id
        };
      }
      break;
    }

    case 'TODO_COMPLETED': {
      const todoId = Number(payload.todo_id);
      const existing = updatedState.todos[todoId];
      if (existing) {
        updatedState.todos[todoId] = {
          ...existing,
          status: 'completed',
          version: existing.version + 1,
          updated_at: event.created_at,
          updated_by: event.session_id
        };
      }
      break;
    }

    case 'TODO_DELETED': {
      const todoId = Number(payload.todo_id);
      delete updatedState.todos[todoId];
      break;
    }

    case 'WIKI_UPDATED': {
      const topic = String(payload.topic);
      const existing = updatedState.wiki[topic];
      updatedState.wiki[topic] = {
        topic,
        content: payload.content,
        version: existing ? existing.version + 1 : 1,
        updated_at: event.created_at,
        updated_by: event.session_id
      };
      break;
    }

    case 'RULE_ADDED': {
      const ruleId = String(payload.rule_id);
      const ruleContent = String(payload.content);
      const existing = updatedState.rules[ruleId];
      updatedState.rules[ruleId] = {
        id: ruleId,
        content: ruleContent,
        version: existing ? existing.version + 1 : 1,
        created_by: event.session_id,
        updated_at: event.created_at
      };
      break;
    }

    case 'RULE_REMOVED': {
      const ruleId = String(payload.rule_id);
      delete updatedState.rules[ruleId];
      break;
    }

    case 'DECISION_RECORDED': {
      const decisionId = String(payload.decision_id);
      const existing = updatedState.decisions[decisionId];
      updatedState.decisions[decisionId] = {
        id: decisionId,
        title: payload.title,
        context: payload.context,
        decision: payload.decision,
        version: existing ? existing.version + 1 : 1,
        updated_at: event.created_at,
        updated_by: event.session_id
      };
      break;
    }

    case 'HANDOFF_CREATED':
    case 'SESSION_DISCONNECTED': {
      const handoffData = event.type === 'HANDOFF_CREATED' ? payload : payload.handoff;
      if (handoffData) {
        updatedState.handoffs.push({
          session_id: handoffData.session_id || event.session_id,
          summary: handoffData.summary || '',
          timestamp: handoffData.timestamp || event.created_at,
          payload: handoffData,
          source: event.type === 'HANDOFF_CREATED' ? 'agent' : 'system'
        });
        // Cap handoffs to prevent unbounded growth
        if (updatedState.handoffs.length > HANDOFF_HISTORY_LIMIT) {
          updatedState.handoffs = updatedState.handoffs.slice(-HANDOFF_HISTORY_LIMIT);
        }
      }
      break;
    }

    case 'TODO_CLAIMED': {
      const todoId = Number(payload.todo_id);
      const existing = updatedState.todos[todoId];
      if (existing) {
        updatedState.todos[todoId] = {
          ...existing,
          claimed_by: payload.session_id,
          claimed_at: payload.claimed_at
        };
      }
      break;
    }

    case 'TODO_UNCLAIMED': {
      const todoId = Number(payload.todo_id);
      const existing = updatedState.todos[todoId];
      if (existing) {
        const { claimed_by, claimed_at, ...rest } = existing;
        updatedState.todos[todoId] = rest;
      }
      break;
    }

    case 'TODO_CONFLICT': {
      updatedState.conflicts.push({
        todo_id: Number(payload.todo_id),
        conflicting_session_id: payload.conflicting_session_id,
        conflict_type: payload.conflict_type,
        detected_at: event.created_at,
        detected_by_session: event.session_id,
        conflicting_sessions: payload.conflicting_sessions,
        hint: payload.hint
      });
      if (updatedState.conflicts.length > CONFLICT_HISTORY_LIMIT) {
        updatedState.conflicts = updatedState.conflicts.slice(-CONFLICT_HISTORY_LIMIT);
      }
      break;
    }

    case 'MESSAGE_SENT': {
      updatedState.messages.push({
        from_session_id: payload.from_session_id,
        to_session_id: payload.to_session_id,
        content: payload.content,
        sent_at: payload.sent_at,
        event_id: event.id
      });
      if (updatedState.messages.length > MESSAGE_HISTORY_LIMIT) {
        updatedState.messages = updatedState.messages.slice(-MESSAGE_HISTORY_LIMIT);
      }
      break;
    }

    case 'BROADCAST': {
      updatedState.broadcasts.push({
        from_session_id: payload.from_session_id,
        content: payload.content,
        sent_at: payload.sent_at,
        event_id: event.id
      });
      if (updatedState.broadcasts.length > BROADCAST_HISTORY_LIMIT) {
        updatedState.broadcasts = updatedState.broadcasts.slice(-BROADCAST_HISTORY_LIMIT);
      }
      break;
    }

    default:
      // Other events like heartbeats do not mutate materialized models directly
      break;
  }

  return updatedState;
}
