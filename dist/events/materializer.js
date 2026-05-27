import { getEvents, getLatestSnapshot, createSnapshot } from './store.js';
export function createInitialState() {
    return {
        todos: {},
        wiki: {},
        rules: [],
        decisions: {},
        handoffs: [],
        lastEventId: 0
    };
}
// In-memory cache for materialized project states to support high-performance incremental updates
const projectCache = new Map();
export function invalidateProjectCache(projectId) {
    projectCache.delete(projectId);
}
export function projectEvent(state, event) {
    const updatedState = {
        todos: { ...state.todos },
        wiki: { ...state.wiki },
        rules: [...state.rules],
        decisions: { ...state.decisions },
        handoffs: [...state.handoffs],
        lastEventId: event.id
    };
    let payload;
    try {
        payload = JSON.parse(event.payload);
    }
    catch (e) {
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
        case 'RULE_REMOVED': {
            const ruleContent = String(payload.content);
            updatedState.rules = updatedState.rules.filter(r => r !== ruleContent);
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
                // Cap handoffs to last 50 to prevent unbounded growth in snapshots
                if (updatedState.handoffs.length > 50) {
                    updatedState.handoffs = updatedState.handoffs.slice(-50);
                }
            }
            break;
        }
        default:
            // Other events like heartbeats do not mutate materialized models directly
            break;
    }
    return updatedState;
}
export function materializeProject(projectId, triggerSnapshotCheck = true) {
    const cached = projectCache.get(projectId);
    let state;
    let startEventId = 0;
    let lastSnapshotEventId = 0;
    if (cached) {
        state = cached.state;
        startEventId = cached.lastEventId;
        lastSnapshotEventId = cached.lastSnapshotEventId;
    }
    else {
        const latestSnapshot = getLatestSnapshot(projectId);
        state = createInitialState();
        if (latestSnapshot) {
            try {
                state = { ...createInitialState(), ...JSON.parse(latestSnapshot.snapshot_json) };
                startEventId = latestSnapshot.event_id;
                lastSnapshotEventId = latestSnapshot.event_id;
            }
            catch (e) {
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
    // Snapshot trigger: check count of events since last snapshot
    // Formula: events.length (new events) + (startEventId - lastSnapshotEventId) (events counted in previous iterations)
    // When cache is cold and no snapshot exists: startEventId=0, lastSnapshotEventId=0 → events.length
    // When loading from snapshot: startEventId=snapshot.event_id, lastSnapshotEventId=snapshot.event_id → events.length
    // When loading from cache: startEventId=cached.lastEventId, lastSnapshotEventId=cached.lastSnapshotEventId → correct cumulative count
    if (triggerSnapshotCheck && state.lastEventId > 0) {
        const eventsSinceSnapshot = events.length + (startEventId - lastSnapshotEventId);
        if (eventsSinceSnapshot >= 100) {
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
