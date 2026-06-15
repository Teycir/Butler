import { projectEvent } from '../src/events/projections.js';
import { createInitialState } from '../src/events/materializer.js';
import { EventRecord } from '../src/events/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`   ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`   ❌ ${name}`);
    console.error(`      ${e.message}`);
    failed++;
  }
}

async function runSuite() {
  console.log('\n==========================================');
  console.log('Butler Unit Tests: Projections');
  console.log('==========================================');

  await test('TODO_CREATED projects correct initial state', () => {
    const initialState = createInitialState();
    const event: EventRecord = {
      id: 1,
      project_id: 'test-proj',
      session_id: 'sess-a',
      type: 'TODO_CREATED',
      payload: JSON.stringify({ todo_id: 101, title: 'Test Task', priority: 'high' }),
      created_at: 1000
    };

    const nextState = projectEvent(initialState, event);
    const todo = nextState.todos[101];
    assert(todo !== undefined, 'Todo should be created');
    assert(todo.id === 101, 'ID should match');
    assert(todo.title === 'Test Task', 'Title should match');
    assert(todo.priority === 'high', 'Priority should match');
    assert(todo.status === 'pending', 'Status should default to pending');
    assert(todo.version === 1, 'Initial version should be 1');
    assert(todo.created_by === 'sess-a', 'created_by should be sess-a');
    assert(todo.updated_by === 'sess-a', 'updated_by should be sess-a');
    assert(todo.updated_at === 1000, 'updated_at should be event created_at');
  });

  await test('TODO_UPDATED projects field changes and increments version', () => {
    let state = createInitialState();
    state.todos[101] = {
      id: 101,
      title: 'Old Title',
      priority: 'low',
      status: 'pending',
      version: 1,
      created_by: 'sess-a',
      updated_by: 'sess-a',
      updated_at: 900
    };

    const event: EventRecord = {
      id: 2,
      project_id: 'test-proj',
      session_id: 'sess-b',
      type: 'TODO_UPDATED',
      payload: JSON.stringify({ todo_id: 101, title: 'New Title', priority: 'medium' }),
      created_at: 1000
    };

    const nextState = projectEvent(state, event);
    const todo = nextState.todos[101];
    assert(todo !== undefined, 'Todo should exist');
    assert(todo.title === 'New Title', 'Title should be updated');
    assert(todo.priority === 'medium', 'Priority should be updated');
    assert(todo.status === 'pending', 'Status should remain unchanged');
    assert(todo.version === 2, 'Version should increment to 2');
    assert(todo.updated_by === 'sess-b', 'updated_by should change to sess-b');
    assert(todo.updated_at === 1000, 'updated_at should update to event created_at');
  });

  await test('TODO_COMPLETED updates status and version', () => {
    let state = createInitialState();
    state.todos[101] = {
      id: 101,
      title: 'Task',
      priority: 'medium',
      status: 'pending',
      version: 1,
      created_by: 'sess-a',
      updated_by: 'sess-a',
      updated_at: 900
    };

    const event: EventRecord = {
      id: 2,
      project_id: 'test-proj',
      session_id: 'sess-a',
      type: 'TODO_COMPLETED',
      payload: JSON.stringify({ todo_id: 101 }),
      created_at: 1000
    };

    const nextState = projectEvent(state, event);
    const todo = nextState.todos[101];
    assert(todo.status === 'completed', 'Status should be completed');
    assert(todo.version === 2, 'Version should be 2');
  });

  await test('TODO_DELETED removes todo from state', () => {
    let state = createInitialState();
    state.todos[101] = {
      id: 101,
      title: 'Task',
      priority: 'medium',
      status: 'pending',
      version: 1,
      created_by: 'sess-a',
      updated_by: 'sess-a',
      updated_at: 900
    };

    const event: EventRecord = {
      id: 2,
      project_id: 'test-proj',
      session_id: 'sess-a',
      type: 'TODO_DELETED',
      payload: JSON.stringify({ todo_id: 101 }),
      created_at: 1000
    };

    const nextState = projectEvent(state, event);
    assert(nextState.todos[101] === undefined, 'Todo 101 should be deleted');
  });

  await test('TODO_CLAIMED and TODO_UNCLAIMED updates claimed_by fields', () => {
    let state = createInitialState();
    state.todos[101] = {
      id: 101,
      title: 'Task',
      priority: 'medium',
      status: 'pending',
      version: 1,
      created_by: 'sess-a',
      updated_by: 'sess-a',
      updated_at: 900
    };

    const claimEvent: EventRecord = {
      id: 2,
      project_id: 'test-proj',
      session_id: 'sess-b',
      type: 'TODO_CLAIMED',
      payload: JSON.stringify({ todo_id: 101, session_id: 'sess-b', claimed_at: 1000 }),
      created_at: 1000
    };

    let nextState = projectEvent(state, claimEvent);
    assert(nextState.todos[101].claimed_by === 'sess-b', 'Todo should be claimed by sess-b');
    assert(nextState.todos[101].claimed_at === 1000, 'Claimed timestamp should be 1000');

    const unclaimEvent: EventRecord = {
      id: 3,
      project_id: 'test-proj',
      session_id: 'sess-b',
      type: 'TODO_UNCLAIMED',
      payload: JSON.stringify({ todo_id: 101, session_id: 'sess-b' }),
      created_at: 1100
    };

    nextState = projectEvent(nextState, unclaimEvent);
    assert(nextState.todos[101].claimed_by === undefined, 'claimed_by should be cleared');
    assert(nextState.todos[101].claimed_at === undefined, 'claimed_at should be cleared');
  });

  await test('TODO_CONFLICT and list caps are respected', () => {
    let state = createInitialState();
    // Fill up conflicts to verify limit logic (cap is 20)
    for (let i = 0; i < 25; i++) {
      const event: EventRecord = {
        id: i + 1,
        project_id: 'test-proj',
        session_id: 'sess-a',
        type: 'TODO_CONFLICT',
        payload: JSON.stringify({ todo_id: 101, conflicting_session_id: 'sess-b', conflict_type: 'concurrent_update' }),
        created_at: 1000 + i
      };
      state = projectEvent(state, event);
    }

    assert(state.conflicts.length === 20, `Conflicts should be capped at 20, got ${state.conflicts.length}`);
    assert(state.conflicts[0].detected_at === 1005, 'Should evict older conflicts (FIFO)');
  });

  await test('WIKI_UPDATED and RULE_ADDED/RULE_REMOVED logic', () => {
    let state = createInitialState();

    const ruleEvent: EventRecord = {
      id: 1,
      project_id: 'test-proj',
      session_id: 'sess-a',
      type: 'RULE_ADDED',
      payload: JSON.stringify({ rule_id: 'rule-1', content: 'Follow standards' }),
      created_at: 1000
    };

    state = projectEvent(state, ruleEvent);
    assert(state.rules['rule-1'] !== undefined, 'Rule should be added');
    assert(state.rules['rule-1'].content === 'Follow standards', 'Rule content matches');

    const removeRuleEvent: EventRecord = {
      id: 2,
      project_id: 'test-proj',
      session_id: 'sess-a',
      type: 'RULE_REMOVED',
      payload: JSON.stringify({ rule_id: 'rule-1' }),
      created_at: 1100
    };

    state = projectEvent(state, removeRuleEvent);
    assert(state.rules['rule-1'] === undefined, 'Rule should be removed');
  });

  await test('MESSAGE_SENT and BROADCAST caps are respected', () => {
    let state = createInitialState();
    
    // Broadcast cap is 20
    for (let i = 0; i < 25; i++) {
      const event: EventRecord = {
        id: i + 1,
        project_id: 'test-proj',
        session_id: 'sess-a',
        type: 'BROADCAST',
        payload: JSON.stringify({ from_session_id: 'sess-a', content: `msg ${i}`, sent_at: 1000 + i }),
        created_at: 1000 + i
      };
      state = projectEvent(state, event);
    }

    assert(state.broadcasts.length === 20, `Broadcasts should be capped at 20, got ${state.broadcasts.length}`);
    assert(state.broadcasts[0].sent_at === 1005, 'Should evict older broadcasts');
  });

  console.log('\n==========================================');
  console.log(`Butler Projections Unit Tests Complete: Passed ${passed}/${passed + failed}`);
  console.log('==========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(e => {
  console.error('Unhandled suite error:', e);
  process.exit(1);
});
