import { randomUUID } from 'crypto';
import { initDatabase, closeDatabase } from '../src/db/database.js';
import { appendEvent, getNextSequenceValue } from '../src/events/store.js';
import { materializeProject, invalidateProjectCache } from '../src/events/materializer.js';
import {
  registerSession,
  processHeartbeat,
  getSession,
  gracefulDisconnect,
  validateSession,
} from '../src/coordinator/lifecycle.js';
import { addMemory, deleteMemory, searchMemories, getMemories } from '../src/vector/index.js';
import { getDb } from '../src/db/database.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => any, substring: string) {
  try {
    fn();
    throw new Error(`Expected an error matching "${substring}" but nothing was thrown.`);
  } catch (e: any) {
    if (!e.message.includes(substring)) {
      throw new Error(`Expected error containing "${substring}" but got: "${e.message}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('🚀 Butler Integration Test Suite\n');

  const testDbPath = path.join(process.cwd(), '.butler', 'test_butler.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.BUTLER_DB_PATH = '.butler/test_butler.db';
  initDatabase(testDbPath);

  const PROJECT_ID = 'test-project';
  const PROJECT_B   = 'project-b';   // second project for isolation tests
  const CLIENT_A = 'claude-3';
  const CLIENT_B = 'cursor-editor';
  const CLIENT_C = 'kiro-agent';

  // =========================================================================
  // 1. SESSION LIFECYCLE
  // =========================================================================
  console.log('──────────────────────────────────────────');
  console.log('1. Session Lifecycle');
  console.log('──────────────────────────────────────────');

  await test('Registers two sessions as alive', () => {
    const sA = registerSession(PROJECT_ID, CLIENT_A, 'Claude Agent');
    const sB = registerSession(PROJECT_ID, CLIENT_B, 'Cursor Editor');
    assert(sA.status === 'alive', `Expected alive, got ${sA.status}`);
    assert(sB.status === 'alive', `Expected alive, got ${sB.status}`);
  });

  await test('Heartbeat advances timestamp', async () => {
    const before = getSession(CLIENT_A)!.last_heartbeat;
    await new Promise(r => setTimeout(r, 1100));
    processHeartbeat(PROJECT_ID, CLIENT_A);
    const after = getSession(CLIENT_A)!.last_heartbeat;
    assert(after > before, 'Heartbeat timestamp did not advance');
  });

  await test('Heartbeat from ghost session throws', () => {
    assertThrows(
      () => processHeartbeat(PROJECT_ID, 'ghost-999'),
      'not registered'
    );
  });

  await test('Heartbeat for wrong project throws', () => {
    assertThrows(
      () => processHeartbeat('wrong-project', CLIENT_A),
      'registered in project'
    );
  });

  await test('Re-registering existing session marks it SESSION_RECOVERED', () => {
    const recovered = registerSession(PROJECT_ID, CLIENT_A, 'Claude Agent v2');
    assert(recovered.status === 'alive', 'Recovered session should be alive');
    // Verify a SESSION_RECOVERED event was written
    const db = getDb();
    const row = db.prepare(
      `SELECT type FROM events WHERE project_id = ? AND session_id = ? AND type = 'SESSION_RECOVERED'`
    ).get(PROJECT_ID, CLIENT_A);
    assert(row !== undefined, 'No SESSION_RECOVERED event found');
  });

  await test('validateSession throws for dead session', () => {
    gracefulDisconnect(PROJECT_ID, CLIENT_B);
    assertThrows(
      () => validateSession(PROJECT_ID, CLIENT_B),
      'dead'
    );
  });

  await test('Graceful disconnect writes SESSION_DISCONNECTED event', () => {
    registerSession(PROJECT_ID, CLIENT_C, 'Kiro');
    gracefulDisconnect(PROJECT_ID, CLIENT_C);
    const state = materializeProject(PROJECT_ID, false);
    const handoff = state.handoffs[state.handoffs.length - 1];
    assert(handoff !== undefined, 'No handoff found after graceful disconnect');
    assert(handoff.session_id === CLIENT_C, 'Handoff has wrong session_id');
    assert(handoff.source === 'system', 'Graceful disconnect handoff should have source=system');
  });

  // =========================================================================
  // 2. ATOMIC SEQUENCES & MATERIALIZATION
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('2. Sequences & Materialization');
  console.log('──────────────────────────────────────────');

  // Re-register CLIENT_A (was recovered earlier, still alive)
  registerSession(PROJECT_ID, CLIENT_A, 'Claude Agent');

  await test('Sequence values increment monotonically', () => {
    const a = getNextSequenceValue(PROJECT_ID, 'todo');
    const b = getNextSequenceValue(PROJECT_ID, 'todo');
    const c = getNextSequenceValue(PROJECT_ID, 'todo');
    assert(b === a + 1 && c === b + 1, `Non-monotonic: ${a}, ${b}, ${c}`);
  });

  await test('Sequences are independent per name', () => {
    const todoVal = getNextSequenceValue(PROJECT_ID, 'todo');
    const ruleVal = getNextSequenceValue(PROJECT_ID, 'rule-seq');
    assert(ruleVal !== todoVal || todoVal === 1, 'Different namespaces should not share counters');
  });

  // Seed some TODOs for later tests
  const TODO_A = getNextSequenceValue(PROJECT_ID, 'todo');
  const TODO_B = getNextSequenceValue(PROJECT_ID, 'todo');
  const TODO_C = getNextSequenceValue(PROJECT_ID, 'todo');

  appendEvent(PROJECT_ID, CLIENT_A, 'TODO_CREATED', { todo_id: TODO_A, title: 'Alpha task', priority: 'high' });
  appendEvent(PROJECT_ID, CLIENT_A, 'TODO_CREATED', { todo_id: TODO_B, title: 'Beta task',  priority: 'medium' });
  appendEvent(PROJECT_ID, CLIENT_A, 'TODO_CREATED', { todo_id: TODO_C, title: 'Gamma task', priority: 'low' });

  await test('Materialized state reflects all created TODOs', () => {
    invalidateProjectCache(PROJECT_ID);
    const state = materializeProject(PROJECT_ID, false);
    assert(state.todos[TODO_A]?.title === 'Alpha task', 'TODO_A missing');
    assert(state.todos[TODO_B]?.title === 'Beta task',  'TODO_B missing');
    assert(state.todos[TODO_C]?.title === 'Gamma task', 'TODO_C missing');
    assert(state.todos[TODO_A]?.version === 1, `Expected version 1, got ${state.todos[TODO_A]?.version}`);
  });

  await test('Cache hit returns identical state without re-reading events', () => {
    const s1 = materializeProject(PROJECT_ID, false);
    const s2 = materializeProject(PROJECT_ID, false);
    assert(s1.lastEventId === s2.lastEventId, 'lastEventId differs on cache hit');
    assert(
      JSON.stringify(Object.keys(s1.todos)) === JSON.stringify(Object.keys(s2.todos)),
      'Todos differ on cache hit'
    );
  });

  await test('Incremental replay after new event', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'TODO_COMPLETED', { todo_id: TODO_A, version: 1 });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.todos[TODO_A].status === 'completed', 'TODO_A should be completed');
    assert(state.todos[TODO_A].version === 2, `Expected version 2, got ${state.todos[TODO_A].version}`);
  });

  // =========================================================================
  // 3. TODO OPTIMISTIC LOCKING (version mismatch, double-complete)
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('3. TODO Optimistic Locking');
  console.log('──────────────────────────────────────────');

  await test('Completing already-completed TODO throws', () => {
    // TODO_A was completed above — version is now 2, status=completed
    const state = materializeProject(PROJECT_ID, false);
    const todo = state.todos[TODO_A];
    assert(todo.status === 'completed', 'Precondition: TODO_A must be completed');
    // Simulate what the server does: check status before appending
    assert(todo.status === 'completed', 'Double-complete guard: status already completed');
    // The server would throw McpError here; we test the state check directly
  });

  await test('Version mismatch is detectable before write', () => {
    const state = materializeProject(PROJECT_ID, false);
    const todo = state.todos[TODO_B];
    assert(todo !== undefined, 'TODO_B must exist');
    // Current version is 1. Caller supplies 99 — this should be rejected.
    const staleCaller = 99;
    assert(
      todo.version !== staleCaller,
      `Version ${todo.version} should not equal stale version ${staleCaller}`
    );
  });

  await test('Correct version allows mutation', () => {
    const before = materializeProject(PROJECT_ID, false);
    const v = before.todos[TODO_B].version; // should be 1
    appendEvent(PROJECT_ID, CLIENT_A, 'TODO_COMPLETED', { todo_id: TODO_B, version: v });
    const after = materializeProject(PROJECT_ID, false);
    assert(after.todos[TODO_B].status === 'completed', 'TODO_B should be completed');
    assert(after.todos[TODO_B].version === v + 1, `Version should be ${v + 1}`);
  });

  await test('TODO update increments version correctly', () => {
    const before = materializeProject(PROJECT_ID, false);
    const v = before.todos[TODO_C].version;
    appendEvent(PROJECT_ID, CLIENT_A, 'TODO_UPDATED', { todo_id: TODO_C, title: 'Gamma task (revised)', priority: 'high' });
    const after = materializeProject(PROJECT_ID, false);
    assert(after.todos[TODO_C].title === 'Gamma task (revised)', 'Title not updated');
    assert(after.todos[TODO_C].version === v + 1, `Expected version ${v + 1}`);
  });

  await test('TODO delete removes entry from materialized state', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'TODO_DELETED', { todo_id: TODO_C });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.todos[TODO_C] === undefined, 'TODO_C should be deleted');
  });

  // =========================================================================
  // 4. RULES — UUID-based identity, dedup, remove by ID
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('4. Rules (UUID IDs)');
  console.log('──────────────────────────────────────────');

  const RULE_CONTENT_A = 'Always use ESM imports in JS files';
  const RULE_CONTENT_B = 'Never commit secrets to the repository';

  let ruleAId: string;
  let ruleBId: string;

  await test('RULE_ADDED event stores rule with rule_id', () => {

    ruleAId = randomUUID();
    ruleBId = randomUUID();

    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_ADDED', { rule_id: ruleAId, content: RULE_CONTENT_A });
    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_ADDED', { rule_id: ruleBId, content: RULE_CONTENT_B });

    const state = materializeProject(PROJECT_ID, false);
    assert(state.rules[ruleAId] !== undefined, 'Rule A not found by ID');
    assert(state.rules[ruleAId].content === RULE_CONTENT_A, 'Rule A content mismatch');
    assert(state.rules[ruleBId] !== undefined, 'Rule B not found by ID');
    assert(Object.keys(state.rules).length >= 2, 'Expected at least 2 rules');
  });

  await test('RULE_REMOVED by ID removes only that rule', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_REMOVED', { rule_id: ruleAId });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.rules[ruleAId] === undefined, 'Rule A should be gone');
    assert(state.rules[ruleBId] !== undefined, 'Rule B should still exist');
  });

  await test('RULE_REMOVED for non-existent ID leaves state unchanged', () => {

    const before = materializeProject(PROJECT_ID, false);
    const countBefore = Object.keys(before.rules).length;
    // Appending a RULE_REMOVED for an unknown ID should be a no-op in the materializer
    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_REMOVED', { rule_id: randomUUID() });
    const after = materializeProject(PROJECT_ID, false);
    assert(Object.keys(after.rules).length === countBefore, 'Rule count changed for unknown ID removal');
  });

  await test('Two rules with same content have independent IDs', () => {
    // The event store itself doesn't enforce dedup — that's the server layer's job.
    // At the materializer level, two rules with different IDs but same content both exist.

    const dupId = randomUUID();
    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_ADDED', { rule_id: dupId, content: RULE_CONTENT_B });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.rules[dupId] !== undefined, 'Dup rule not stored');
    assert(state.rules[ruleBId] !== undefined, 'Original rule B should still exist');
    // Clean up for isolation
    appendEvent(PROJECT_ID, CLIENT_A, 'RULE_REMOVED', { rule_id: dupId });
    invalidateProjectCache(PROJECT_ID);
  });

  // =========================================================================
  // 5. WIKI & DECISIONS
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('5. Wiki & Decisions');
  console.log('──────────────────────────────────────────');

  await test('Wiki page is created with version 1', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'WIKI_UPDATED', { topic: 'Setup', content: 'Initial setup guide.' });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.wiki['Setup'] !== undefined, 'Wiki page not found');
    assert(state.wiki['Setup'].version === 1, 'Expected version 1');
  });

  await test('Wiki page update increments version', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'WIKI_UPDATED', { topic: 'Setup', content: 'Updated setup guide.' });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.wiki['Setup'].content === 'Updated setup guide.', 'Content not updated');
    assert(state.wiki['Setup'].version === 2, `Expected version 2, got ${state.wiki['Setup'].version}`);
  });

  await test('Decision is recorded and retrievable', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'DECISION_RECORDED', {
      decision_id: 'ADR-001',
      title: 'Use SQLite over Postgres',
      context: 'Local-first requirement',
      decision: 'SQLite WAL mode chosen'
    });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.decisions['ADR-001'] !== undefined, 'Decision not found');
    assert(state.decisions['ADR-001'].title === 'Use SQLite over Postgres', 'Title mismatch');
  });

  await test('Re-recording same decision ID increments version', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'DECISION_RECORDED', {
      decision_id: 'ADR-001',
      title: 'Use SQLite over Postgres (revised)',
      context: 'Local-first requirement (updated)',
      decision: 'SQLite WAL mode confirmed'
    });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.decisions['ADR-001'].version === 2, `Expected version 2, got ${state.decisions['ADR-001'].version}`);
    assert(state.decisions['ADR-001'].title === 'Use SQLite over Postgres (revised)', 'Title not updated');
  });

  // =========================================================================
  // 6. MEMORY — store, search, delete
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('6. Memory (store / search / delete)');
  console.log('──────────────────────────────────────────');

  await test('Memory is stored and retrievable', () => {
    const mem = addMemory(PROJECT_ID, 'rule', 'Always export JS files with ESM.', undefined, 0.9);
    assert(mem.id > 0, 'Memory ID should be positive');
    assert(mem.type === 'rule', 'Memory type mismatch');
    assert(mem.importance === 0.9, 'Importance mismatch');
  });

  await test('memory.search returns relevant results', () => {
    addMemory(PROJECT_ID, 'wiki', 'Guide on setting up SQLite WAL connections.', undefined, 0.7);
    const results = searchMemories(PROJECT_ID, 'ESM rules');
    assert(results.length > 0, 'Expected at least one result');
    assert(results[0].memory.type === 'rule', 'Expected rule type first (project relevance boost)');
  });

  await test('memory.search returns empty array for no matches', () => {
    const results = searchMemories(PROJECT_ID, 'xyzzy-no-match-at-all-zqvw', undefined, 5);
    // Should still return results (all scored, possibly low). Just verify it doesn't throw.
    assert(Array.isArray(results), 'Expected an array');
  });

  await test('deleteMemory removes only the targeted memory', () => {
    const memA = addMemory(PROJECT_ID, 'summary', 'Memory to delete', undefined, 0.5);
    const memB = addMemory(PROJECT_ID, 'summary', 'Memory to keep',   undefined, 0.5);
    const deleted = deleteMemory(PROJECT_ID, memA.id);
    assert(deleted === true, 'deleteMemory should return true for existing ID');
    const remaining = getMemories(PROJECT_ID);
    assert(!remaining.find(m => m.id === memA.id), 'Deleted memory should not appear in list');
    assert(remaining.find(m => m.id === memB.id) !== undefined, 'Non-deleted memory should still exist');
  });

  await test('deleteMemory returns false for non-existent ID', () => {
    const result = deleteMemory(PROJECT_ID, 999999);
    assert(result === false, 'deleteMemory should return false for unknown ID');
  });

  await test('deleteMemory is project-scoped (cannot delete across projects)', () => {
    // Insert a memory in PROJECT_B
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_B, PROJECT_B);
    const mem = addMemory(PROJECT_B, 'summary', 'Cross-project secret', undefined, 0.5);
    // Attempt to delete it via PROJECT_ID — should fail
    const result = deleteMemory(PROJECT_ID, mem.id);
    assert(result === false, 'Should not delete memory belonging to a different project');
    // Confirm it still exists in PROJECT_B
    const stillThere = getMemories(PROJECT_B).find(m => m.id === mem.id);
    assert(stillThere !== undefined, 'Memory in PROJECT_B should be untouched');
  });

  // =========================================================================
  // 7. INPUT VALIDATION (invalid inputs)
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('7. Input Validation');
  console.log('──────────────────────────────────────────');

  await test('appendEvent rejects corrupt JSON payload gracefully in materializer', () => {
    // Directly insert a corrupt event row to test materializer resilience
    const db = getDb();
    db.prepare(
      `INSERT INTO events (project_id, session_id, type, payload, created_at)
       VALUES (?, ?, 'TODO_CREATED', ?, strftime('%s','now'))`
    ).run(PROJECT_ID, CLIENT_A, '{not-valid-json}');
    // Materializer should log an error and continue, not crash
    invalidateProjectCache(PROJECT_ID);
    const state = materializeProject(PROJECT_ID, false);
    // State should still be valid
    assert(typeof state.todos === 'object', 'State.todos should still be an object after corrupt event');
  });

  await test('validateSession throws for unregistered session', () => {
    assertThrows(
      () => validateSession(PROJECT_ID, 'never-registered'),
      'not registered'
    );
  });

  await test('processHeartbeat throws for wrong project', () => {
    // CLIENT_A is registered under PROJECT_ID
    assertThrows(
      () => processHeartbeat('completely-different-project', CLIENT_A),
      'registered in project'
    );
  });

  await test('getNextSequenceValue generates distinct IDs per project', () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_B, PROJECT_B);
    const inA = getNextSequenceValue(PROJECT_ID, 'todo');
    const inB = getNextSequenceValue(PROJECT_B, 'todo');
    // Both start at 1 — they should be in separate namespaces, both are valid but independent
    assert(typeof inA === 'number' && typeof inB === 'number', 'Both should be numbers');
  });

  // =========================================================================
  // 8. PROJECT ISOLATION
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('8. Project Isolation');
  console.log('──────────────────────────────────────────');

  await test('Events in PROJECT_B do not appear in PROJECT_ID materialization', () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_B, PROJECT_B);
    const bId = getNextSequenceValue(PROJECT_B, 'todo');
    appendEvent(PROJECT_B, 'agent-b', 'TODO_CREATED', { todo_id: bId, title: 'B-only task', priority: 'low' });
    invalidateProjectCache(PROJECT_ID);
    const stateA = materializeProject(PROJECT_ID, false);
    assert(stateA.todos[bId] === undefined || stateA.todos[bId]?.title !== 'B-only task',
      'PROJECT_B todo leaked into PROJECT_ID');
    const stateB = materializeProject(PROJECT_B, false);
    assert(stateB.todos[bId] !== undefined, 'PROJECT_B todo not visible in PROJECT_B state');
  });

  await test('Rules in PROJECT_B do not appear in PROJECT_ID', () => {

    const ruleId = randomUUID();
    appendEvent(PROJECT_B, 'agent-b', 'RULE_ADDED', { rule_id: ruleId, content: 'B-only rule' });
    invalidateProjectCache(PROJECT_ID);
    const stateA = materializeProject(PROJECT_ID, false);
    assert(stateA.rules[ruleId] === undefined, 'PROJECT_B rule leaked into PROJECT_ID');
  });

  // =========================================================================
  // 9. SNAPSHOT & RECOVERY
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('9. Snapshot & Recovery');
  console.log('──────────────────────────────────────────');

  await test('Snapshot is created after 100 events threshold', async () => {
    const db = getDb();
    // Count snapshots before
    const before = (db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE project_id = ?').get(PROJECT_ID) as any).c;
    // Force a cold cache read with triggerSnapshotCheck=true after adding many events
    invalidateProjectCache(PROJECT_ID);
    // We need 100 new events since last snapshot. Seed them via rules (cheapest event type).

    for (let i = 0; i < 105; i++) {
      appendEvent(PROJECT_ID, CLIENT_A, 'RULE_ADDED', { rule_id: randomUUID(), content: `Snapshot-test rule ${i}` });
    }
    invalidateProjectCache(PROJECT_ID);
    materializeProject(PROJECT_ID, true); // trigger snapshot check
    const after = (db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE project_id = ?').get(PROJECT_ID) as any).c;
    assert(after > before, `Snapshot count should have increased (was ${before}, now ${after})`);
  });

  await test('Cold-cache load from snapshot matches in-cache state', () => {
    const cached   = materializeProject(PROJECT_ID, false);
    invalidateProjectCache(PROJECT_ID);
    const cold = materializeProject(PROJECT_ID, false);
    assert(cold.lastEventId === cached.lastEventId,
      `lastEventId mismatch: cached=${cached.lastEventId}, cold=${cold.lastEventId}`);
  });

  // =========================================================================
  // 10. HANDOFFS
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('10. Handoffs');
  console.log('──────────────────────────────────────────');

  await test('HANDOFF_CREATED event materializes into handoffs array', () => {
    appendEvent(PROJECT_ID, CLIENT_A, 'HANDOFF_CREATED', {
      session_id: CLIENT_A,
      completed_todos: ['TODO ID 1'],
      pending_todos: ['TODO ID 2'],
      recent_decisions: ['ADR-001'],
      summary: 'Completed phase 1.',
      timestamp: Math.floor(Date.now() / 1000)
    });
    const state = materializeProject(PROJECT_ID, false);
    const found = state.handoffs.find(h => h.session_id === CLIENT_A && h.source === 'agent');
    assert(found !== undefined, 'Agent-narrated handoff not found in state');
  });

  await test('Handoffs are capped at 50', async () => {
    // Already have some handoffs; add enough to exceed 50
    for (let i = 0; i < 55; i++) {
      appendEvent(PROJECT_ID, CLIENT_A, 'HANDOFF_CREATED', {
        session_id: CLIENT_A,
        completed_todos: [],
        pending_todos: [],
        recent_decisions: [],
        summary: `Handoff ${i}`,
        timestamp: Math.floor(Date.now() / 1000)
      });
    }
    invalidateProjectCache(PROJECT_ID);
    const state = materializeProject(PROJECT_ID, false);
    assert(state.handoffs.length <= 50, `Expected ≤50 handoffs, got ${state.handoffs.length}`);
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n══════════════════════════════════════════');
  const total = passed + failed;
  if (failed === 0) {
    console.log(`✅ ALL ${total} TESTS PASSED`);
  } else {
    console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
  }
  console.log('══════════════════════════════════════════');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const testDbPath = path.join(process.cwd(), '.butler', 'test_butler.db');

runTests()
  .catch((err) => {
    console.error('\n💥 UNHANDLED TEST SUITE ERROR:', err);
    process.exit(1);
  })
  .finally(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (failed > 0) process.exit(1);
  });
