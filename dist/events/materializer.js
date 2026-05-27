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
        state = structuredClone(cached.state);
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
    let eventCount = 0;
    for (const event of events) {
        state = projectEvent(state, event);
        eventCount++;
    }
    // Snapshot trigger: check events since last snapshot, not just events in this call
    if (triggerSnapshotCheck && state.lastEventId > 0) {
        const eventsSinceSnapshot = state.lastEventId - lastSnapshotEventId;
        if (eventsSinceSnapshot >= 100) {
            createSnapshot(projectId, state.lastEventId, state);
            lastSnapshotEventId = state.lastEventId;
        }
    }
    projectCache.set(projectId, {
        state: structuredClone(state),
        lastEventId: state.lastEventId,
        lastSnapshotEventId: lastSnapshotEventId
    });
    return state;
}
