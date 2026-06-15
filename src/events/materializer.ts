import { HandoffPayload } from './types.js';
import { getEvents, getLatestSnapshot, createSnapshot } from './store.js';
import { SNAPSHOT_EVENT_INTERVAL } from '../constants.js';
import { projectEvent } from './projections.js';

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
  conflicting_sessions?: string[];
  hint?: string;
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

// BUMP ME: If you modify this interface, you MUST increment SNAPSHOT_SCHEMA_VERSION in src/constants.ts
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

import { registerCloseCallback } from '../db/database.js';

// In-memory cache for materialized project states to support high-performance incremental updates
const projectCache = new Map<string, { state: ProjectState; lastEventId: number; lastSnapshotEventId: number; lastAccessed: number }>();

export function invalidateProjectCache(projectId: string): void {
  projectCache.delete(projectId);
}

export function invalidateAllCaches(): void {
  projectCache.clear();
}

registerCloseCallback(() => {
  projectCache.clear();
});



export function materializeProject(projectId: string, triggerSnapshotCheck = true): ProjectState {
  const cached = projectCache.get(projectId);
  let state: ProjectState;
  let startEventId = 0;
  let lastSnapshotEventId = 0;

  if (cached) {
    state = cached.state;
    startEventId = cached.lastEventId;
    lastSnapshotEventId = cached.lastSnapshotEventId;
    cached.lastAccessed = Date.now();
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

  // Optimization: on pure cache hit with no new events, return cached state directly
  if (cached && events.length === 0) {
    return cached.state;
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

  // Store the state in the cache and return it directly.
  // The materialized state is treated as immutable, and projectEvent performs copies on write.
  projectCache.set(projectId, {
    state,
    lastEventId: state.lastEventId,
    lastSnapshotEventId: lastSnapshotEventId,
    lastAccessed: Date.now()
  });

  // Evict entries older than 30 minutes (1800000 ms)
  const now = Date.now();
  for (const [key, val] of projectCache.entries()) {
    if (now - val.lastAccessed > 1800000) {
      projectCache.delete(key);
    }
  }

  // Evict the least recently used entry if the cache size exceeds 100 projects
  if (projectCache.size > 100) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of projectCache.entries()) {
      if (v.lastAccessed < oldestTime) {
        oldestTime = v.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) {
      projectCache.delete(oldestKey);
    }
  }

  return state;
}
