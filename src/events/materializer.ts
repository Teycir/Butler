import { EventRecord } from './types.js';
import { getEvents, getLatestSnapshot, createSnapshot } from './store.js';

export interface TodoItem {
  id: number;
  title: string;
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'completed';
  version: number;
  updated_at: number;
}

export interface WikiPage {
  topic: string;
  content: string;
  version: number;
}

export interface DecisionItem {
  id: string;
  title: string;
  context: string;
  decision: string;
  version: number;
}

export interface ProjectState {
  todos: Record<number, TodoItem>;
  wiki: Record<string, WikiPage>;
  rules: string[];
  decisions: Record<string, DecisionItem>;
  lastEventId: number;
}

export function createInitialState(): ProjectState {
  return {
    todos: {},
    wiki: {},
    rules: [],
    decisions: {},
    lastEventId: 0
  };
}

// In-memory cache for materialized project states to support high-performance incremental updates
const projectCache = new Map<string, { state: ProjectState; lastEventId: number }>();

export function invalidateProjectCache(projectId: string): void {
  projectCache.delete(projectId);
}

export function projectEvent(state: ProjectState, event: EventRecord): ProjectState {
  const updatedState = {
    todos: { ...state.todos },
    wiki: { ...state.wiki },
    rules: [...state.rules],
    decisions: { ...state.decisions },
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
        updated_at: event.created_at
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
          updated_at: event.created_at
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
          updated_at: event.created_at
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
        version: existing ? existing.version + 1 : 1
      };
      break;
    }

    case 'RULE_ADDED': {
      const ruleContent = String(payload.content);
      if (!updatedState.rules.includes(ruleContent)) {
        updatedState.rules.push(ruleContent);
      }
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
        version: existing ? existing.version + 1 : 1
      };
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

  if (cached) {
    // Deep copy from cache to prevent outside mutations corrupting the cached reference
    state = JSON.parse(JSON.stringify(cached.state));
    startEventId = cached.lastEventId;
  } else {
    const latestSnapshot = getLatestSnapshot(projectId);
    state = createInitialState();

    if (latestSnapshot) {
      try {
        state = JSON.parse(latestSnapshot.snapshot_json);
        startEventId = latestSnapshot.event_id;
      } catch (e) {
        console.error(`Failed to load snapshot for project ${projectId}, replaying from beginning:`, e);
      }
    }
  }

  // Fetch and replay only the events appended since our last processed checkpoint
  const events = getEvents(projectId, startEventId);
  let eventCount = 0;

  for (const event of events) {
    state = projectEvent(state, event);
    eventCount++;
  }

  // Cache a deep copy of the newly computed state
  projectCache.set(projectId, {
    state: JSON.parse(JSON.stringify(state)),
    lastEventId: state.lastEventId
  });

  // Snapshot Trigger Rules: snapshot every 100 events
  if (triggerSnapshotCheck && eventCount >= 100 && state.lastEventId > startEventId) {
    createSnapshot(projectId, state.lastEventId, state);
  }

  return state;
}
