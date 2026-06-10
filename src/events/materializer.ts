import { EventRecord, HandoffPayload } from './types.js';
import { getEvents, getLatestSnapshot, createSnapshot } from './store.js';
import {
  SNAPSHOT_EVENT_INTERVAL,
  HANDOFF_HISTORY_LIMIT,
  CONFLICT_HISTORY_LIMIT,
  MESSAGE_HISTORY_LIMIT,
  BROADCAST_HISTORY_LIMIT
} from '../constants.js';

export interface TodoItem {
  id: number;
  title: string;
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'completed';
  version: number;
  created_by: string; // session_id of creator
  updated_at: number;
  updated_by: string; // session_id of last updater
  claimed_by?: string; // session_id currently holding the claim, if any
  claimed_at?: number;
}

export interface WikiPage {
  topic: string;
  content: string;
  version: number;
  updated_at: number;
  updated_by: string; // session_id of last writer
}

export interface DecisionItem {
  id: string;
  title: string;
  context: string;
  decision: string;
  version: number;
  updated_at: number;
  updated_by: string;
}

export interface ConflictRecord {
  todo_id: number;
  conflicting_session_id: string;
  conflict_type: 'concurrent_complete' | 'concurrent_update';
  detected_at: number;
  detected_by_session: string;
}

export interface MessageRecord {
  from_session_id: string;
  to_session_id: string;
  content: string;
  sent_at: number;
  event_id: number;
}

export interface BroadcastRecord {
  from_session_id: string;
  content: string;
  sent_at: number;
  event_id: number;
}

export interface ProjectState {
  todos: Record<number, TodoItem>;
  wiki: Record<string, WikiPage>;
  rules: Record<string, { id: string; content: string; version: number; created_by: string; updated_at: number }>;
  decisions: Record<string, DecisionItem>;
  handoffs: Array<{ session_id: string; summary: string; timestamp: number; payload: HandoffPayload; source?: 'agent' | 'system' }>;
  conflicts: ConflictRecord[];       // Phase 3.1 — recent unresolved conflicts
  messages: MessageRecord[];         // Phase 3.3 — recent direct messages
  broadcasts: BroadcastRecord[];     // Phase 3.4 — recent broadcasts
  lastEventId: number;
}

export function createInitialState(): ProjectState {
  return {
    todos: {},
    wiki: {},
    rules: {},
    decisions: {},
    handoffs: [],
    conflicts: [],
    messages: [],
    broadcasts: [],
    lastEventId: 0
  };
}

// In-memory cache for materialized project states to support high-performance incremental updates
const projectCache = new Map<string, { state: ProjectState; lastEventId: number; lastSnapshotEventId: number }>();

export function invalidateProjectCache(projectId: string): void {
  projectCache.delete(projectId);
}

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
        detected_by_session: event.session_id
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

export function materializeProject(projectId: string, triggerSnapshotCheck = true): ProjectState {
  const cached = projectCache.get(projectId);
  let state: ProjectState;
  let startEventId = 0;
  let lastSnapshotEventId = 0;

  if (cached) {
    state = cached.state;
    startEventId = cached.lastEventId;
    lastSnapshotEventId = cached.lastSnapshotEventId;
  } else {
    const latestSnapshot = getLatestSnapshot(projectId);
    state = createInitialState();

    if (latestSnapshot) {
      try {
        state = { ...createInitialState(), ...JSON.parse(latestSnapshot.snapshot_json) };
        startEventId = latestSnapshot.event_id;
        lastSnapshotEventId = latestSnapshot.event_id;
      } catch (e) {
        console.error(`Failed to load snapshot for project ${projectId}, replaying from beginning:`, e);
      }
    }
  }

  const events = getEvents(projectId, startEventId);

  // Optimization: on pure cache hit with no new events, return cached clone directly
  if (cached && events.length === 0) {
    return structuredClone(cached.state);
  }

  for (const event of events) {
    state = projectEvent(state, event);
  }

  // Snapshot trigger: calculate events since last snapshot
  // Use absolute event IDs to avoid cumulative counting errors
  if (triggerSnapshotCheck && state.lastEventId > 0) {
    const eventsSinceSnapshot = state.lastEventId - lastSnapshotEventId;
    if (eventsSinceSnapshot >= SNAPSHOT_EVENT_INTERVAL) {
      createSnapshot(projectId, state.lastEventId, state);
      lastSnapshotEventId = state.lastEventId;
    }
  }

  // Store a clone in cache and return a separate clone to prevent mutation leakage
  const cacheClone = structuredClone(state);
  projectCache.set(projectId, {
    state: cacheClone,
    lastEventId: state.lastEventId,
    lastSnapshotEventId: lastSnapshotEventId
  });

  return structuredClone(state);
}
