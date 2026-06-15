import { initDatabase, getDb } from '../src/db/database.js';
import { buildOrchestratorGraph } from '../src/langgraph/orchestrator.js';
import { materializeProject } from '../src/events/materializer.js';
import { appendEvent } from '../src/events/store.js';
import { now as getCurrentTimestamp } from '../src/constants.js';
import path from 'path';
import fs from 'fs';

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

async function runTests() {
  console.log('🚀 Butler LangGraph Agent Orchestrator Test Suite\n');

  const testDbPath = path.join(process.cwd(), '.butler', 'test_orchestrator.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.BUTLER_DB_PATH = '.butler/test_orchestrator.db';
  initDatabase(testDbPath);

  const PROJECT_ID = 'orchestrator-test-project';

  // Register project in DB so foreign keys resolve
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, PROJECT_ID);

  // =========================================================================
  // 1. HAPPY PATH
  // =========================================================================

  await test('Executes planning, creates TODOs, and interrupts on implementation', async () => {
    const app = buildOrchestratorGraph();
    const config = { configurable: { thread_id: 'workflow-thread-1' } };

    // Initial state setup
    const initialState = {
      projectId: PROJECT_ID,
      task: 'Fix type errors in user authentication module',
      todoIds: [],
      assignedAgent: null,
      diff: null,
      testPassed: null,
      testLogs: null,
      loopCount: 0,
      lastUpdatedAt: null,
      error: null,
      status: 'planning' as const
    };

    // Invoke the graph - it should planning, then implementation, and then interrupt
    try {
      await app.invoke(initialState, config);
    } catch (e: any) {
      // Catch LangGraph interrupt throw
    }

    // Let's retrieve the latest state checkpoint from the checkpointer
    const stateTuple = await app.getState(config);
    
    assert(stateTuple !== undefined, 'Workflow state should be stored in checkpointer');
    assert(stateTuple.values.status === 'implementing', `Expected status to be implementing, got: ${stateTuple.values.status}`);
    assert(stateTuple.values.assignedAgent === 'kiro-cli', `Expected assigned agent to be kiro-cli, got: ${stateTuple.values.assignedAgent}`);
    assert(stateTuple.values.todoIds.length > 0, 'Expected a planned TODO task ID to be registered');

    // Confirm that the planned TODO actually exists in Butler database
    const materialized = materializeProject(PROJECT_ID, false);
    const todoId = stateTuple.values.todoIds[0];
    const todo = materialized.todos[todoId];
    assert(todo !== undefined, `Planned TODO #${todoId} should exist in database`);
    assert(todo.title.includes('Fix type errors'), 'TODO title does not match task intent');
    assert(todo.status === 'pending', 'TODO should start as pending');
  });

  await test('Resumes workflow from checkpointer once Kiro completes the TODO', async () => {
    const app = buildOrchestratorGraph();
    const config = { configurable: { thread_id: 'workflow-thread-1' } };

    // Get current state to resolve which TODO we need to complete
    const stateTupleBefore = await app.getState(config);
    const todoId = stateTupleBefore.values.todoIds[0];

    // Simulate Kiro CLI completing the TODO via events
    appendEvent(PROJECT_ID, 'kiro-session', 'TODO_COMPLETED', {
      todo_id: todoId,
      version: 1
    });

    // Resume execution by updating state and running it
    const resultState = await app.invoke(null, config);

    assert(resultState.status === 'completed', `Expected final status to be completed, got: ${resultState.status}`);
    assert(resultState.assignedAgent === null, 'Expected final assigned agent to be null');
    assert(resultState.testPassed === true, 'Expected testPassed to be true');

    const stateTupleAfter = await app.getState(config);
    assert(stateTupleAfter.values.status === 'completed', 'Checkpointed state should be completed');
  });

  // =========================================================================
  // 2. RETRY LOOP EXHAUSTION
  // =========================================================================

  await test('Fails workflow when loop limit is exceeded', async () => {
    const app = buildOrchestratorGraph();
    const config = { configurable: { thread_id: 'workflow-thread-limit-fail' } };

    const initialState = {
      projectId: PROJECT_ID,
      task: 'Fix warnings',
      todoIds: [],
      assignedAgent: null,
      diff: null,
      testPassed: null,
      testLogs: null,
      loopCount: 0,
      lastUpdatedAt: null,
      error: null,
      status: 'planning' as const
    };

    // 1. Run planning node first, which will transition to implementation and interrupt
    try {
      await app.invoke(initialState, config);
    } catch (e) {}

    // 2. Update the state with loopCount = 3 (limit reached)
    await app.updateState(config, { loopCount: 3 });

    // 3. Resume the graph. Since the TODO is not completed, it runs implementationNode,
    // detects loopCount >= 3, and fails.
    const resultState = await app.invoke(null, config);

    assert(resultState.status === 'failed', `Expected status to be failed, got: ${resultState.status}`);
    assert(resultState.error !== null && resultState.error.includes('retry limit'), `Expected retry limit error message, got: ${resultState.error}`);
    assert(resultState.assignedAgent === null, 'Assigned agent should be null on failure');
  });

  // =========================================================================
  // 3. STEP INACTIVITY TIMEOUTS
  // =========================================================================

  await test('Fails workflow when implementation node times out', async () => {
    const app = buildOrchestratorGraph();
    const config = { configurable: { thread_id: 'workflow-thread-timeout-fail' } };

    const initialState = {
      projectId: PROJECT_ID,
      task: 'Fix type safety',
      todoIds: [],
      assignedAgent: null,
      diff: null,
      testPassed: null,
      testLogs: null,
      loopCount: 0,
      lastUpdatedAt: null,
      error: null,
      status: 'planning' as const
    };

    // 1. Run planning, which transitions to implementation and interrupts
    try {
      await app.invoke(initialState, config);
    } catch (e) {}

    // 2. Update the state with lastUpdatedAt = 40 minutes ago (limit is 30 mins)
    await app.updateState(config, { lastUpdatedAt: getCurrentTimestamp() - 2400 });

    // 3. Resume graph. It should run implementationNode, see timeout, and fail
    const resultState = await app.invoke(null, config);

    assert(resultState.status === 'failed', `Expected status to be failed, got: ${resultState.status}`);
    assert(resultState.error !== null && resultState.error.includes('timed out'), `Expected timeout error message, got: ${resultState.error}`);
  });

  // =========================================================================
  // 4. DATABASE & EXECUTION EXCEPTION HANDLING
  // =========================================================================

  await test('Gracefully catches database errors and records failure state', async () => {
    const app = buildOrchestratorGraph();
    const config = { configurable: { thread_id: 'workflow-thread-db-fail' } };

    const stateWithDbError = {
      // This project_id does NOT exist in projects table, which will trigger an SQLite foreign key constraint crash on sequence insertions
      projectId: 'non-existent-project-id-xyz',
      task: 'Planning error test',
      todoIds: [],
      assignedAgent: null,
      diff: null,
      testPassed: null,
      testLogs: null,
      loopCount: 0,
      lastUpdatedAt: null,
      error: null,
      status: 'planning' as const
    };

    const resultState = await app.invoke(stateWithDbError, config);

    assert(resultState.status === 'failed', `Expected status to be failed, got: ${resultState.status}`);
    assert(resultState.error !== null && resultState.error.includes('FOREIGN KEY'), `Expected foreign key error message, got: ${resultState.error}`);
  });

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);

  // Clean up database file
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch {}

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('Unhandled failure:', e);
  process.exit(1);
});
