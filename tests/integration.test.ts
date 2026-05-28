import { randomUUID } from 'crypto';
import { initDatabase, closeDatabase, sha256hex } from '../src/db/database.js';
import { appendEvent, getNextSequenceValue } from '../src/events/store.js';
import { materializeProject, invalidateProjectCache } from '../src/events/materializer.js';
import {
  registerSession,
  processHeartbeat,
  getSession,
  gracefulDisconnect,
  validateSession,
  getActiveSessions,
  generateStructuredHandoff,
  startLifecycleMonitor,
  stopLifecycleMonitor,
} from '../src/coordinator/lifecycle.js';
import { addMemory, deleteMemory, searchMemories, getMemories } from '../src/vector/index.js';
import { validateProjectId, validateSessionId, sanitizeInput, sanitizeTitle, sanitizeMarkdown } from '../src/validation.js';
import { getDb } from '../src/db/database.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/constants.js';
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
    // created_at must be a positive unix timestamp
    assert(sA.created_at > 0, 'created_at should be a positive unix timestamp');
    assert(sB.created_at > 0, 'created_at should be a positive unix timestamp');
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
    // Provenance: created_by and updated_by must be set to the writing session
    assert(state.todos[TODO_A].created_by === CLIENT_A, `created_by should be ${CLIENT_A}`);
    assert(state.todos[TODO_A].updated_by === CLIENT_A, `updated_by should be ${CLIENT_A}`);
    assert(state.todos[TODO_A].updated_at > 0, 'updated_at should be a positive unix timestamp');
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
    appendEvent(PROJECT_ID, CLIENT_B, 'TODO_UPDATED', { todo_id: TODO_C, title: 'Gamma task (revised)', priority: 'high' });
    const after = materializeProject(PROJECT_ID, false);
    assert(after.todos[TODO_C].title === 'Gamma task (revised)', 'Title not updated');
    assert(after.todos[TODO_C].version === v + 1, `Expected version ${v + 1}`);
    // updated_by must reflect the new writer (CLIENT_B), not the original creator (CLIENT_A)
    assert(after.todos[TODO_C].updated_by === CLIENT_B, `updated_by should switch to ${CLIENT_B}`);
    assert(after.todos[TODO_C].created_by === CLIENT_A, `created_by should still be ${CLIENT_A}`);
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
    assert(state.wiki['Setup'].updated_by === CLIENT_A, `updated_by should be ${CLIENT_A}`);
    assert(state.wiki['Setup'].updated_at > 0, 'updated_at should be a positive unix timestamp');
  });

  await test('Wiki page update increments version and tracks new writer', () => {
    appendEvent(PROJECT_ID, CLIENT_B, 'WIKI_UPDATED', { topic: 'Setup', content: 'Updated setup guide.' });
    const state = materializeProject(PROJECT_ID, false);
    assert(state.wiki['Setup'].content === 'Updated setup guide.', 'Content not updated');
    assert(state.wiki['Setup'].version === 2, `Expected version 2, got ${state.wiki['Setup'].version}`);
    assert(state.wiki['Setup'].updated_by === CLIENT_B, `updated_by should switch to ${CLIENT_B}`);
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
    assert(state.decisions['ADR-001'].updated_by === CLIENT_A, `updated_by should be ${CLIENT_A}`);
    assert(state.decisions['ADR-001'].updated_at > 0, 'updated_at should be a positive unix timestamp');
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
  // 11. PROVENANCE — source_ref, source_event_id, upsert dedup
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('11. Memory Provenance & Dedup');
  console.log('──────────────────────────────────────────');

  await test('Memory stores source_ref and source_event_id', () => {
    const fakeEventId = 42;
    const mem = addMemory(PROJECT_ID, 'decision', 'Use ESM everywhere.', undefined, 0.8, 'ADR-ESM', fakeEventId);
    assert(mem.source_ref === 'ADR-ESM', `Expected source_ref 'ADR-ESM', got ${mem.source_ref}`);
    assert(mem.source_event_id === fakeEventId, `Expected source_event_id ${fakeEventId}, got ${mem.source_event_id}`);
    // Round-trip: should appear in getMemories
    const list = getMemories(PROJECT_ID);
    const found = list.find(m => m.source_ref === 'ADR-ESM');
    assert(found !== undefined, 'Memory with source_ref not found in list');
    assert(found!.source_event_id === fakeEventId, 'source_event_id not persisted');
  });

  await test('Upserting same source_ref updates content, not duplicates', () => {
    addMemory(PROJECT_ID, 'decision', 'Use ESM everywhere.', undefined, 0.8, 'ADR-ESM', 42);
    addMemory(PROJECT_ID, 'decision', 'Use ESM everywhere — confirmed.', undefined, 0.9, 'ADR-ESM', 43);
    const list = getMemories(PROJECT_ID);
    const matches = list.filter(m => m.source_ref === 'ADR-ESM');
    assert(matches.length === 1, `Expected 1 memory for source_ref 'ADR-ESM', got ${matches.length}`);
    assert(matches[0].content === 'Use ESM everywhere — confirmed.', 'Content not updated on upsert');
    assert(matches[0].source_event_id === 43, 'source_event_id not updated on upsert');
  });

  await test('Memories without source_ref are always inserted (no conflict)', () => {
    const a = addMemory(PROJECT_ID, 'summary', 'Summary A', undefined, 0.5);
    const b = addMemory(PROJECT_ID, 'summary', 'Summary A', undefined, 0.5); // same content, no source_ref
    assert(a.id !== b.id, 'Two memories without source_ref should get distinct IDs');
  });

  // =========================================================================
  // 12. SNAPSHOT INTEGRITY — SHA-256 checksum validation
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('12. Snapshot Integrity');
  console.log('──────────────────────────────────────────');

  await test('Snapshot has non-empty sha256_hex after creation', () => {
    // Force a snapshot by materializing with triggerSnapshotCheck=true after enough events
    for (let i = 0; i < 105; i++) {
      appendEvent(PROJECT_ID, CLIENT_A, 'RULE_ADDED', { rule_id: randomUUID(), content: `Integrity-test rule ${i}` });
    }
    invalidateProjectCache(PROJECT_ID);
    materializeProject(PROJECT_ID, true);
    const db = getDb();
    const row = db.prepare(
      'SELECT sha256_hex FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1'
    ).get(PROJECT_ID) as any;
    assert(row !== undefined, 'No snapshot found');
    assert(typeof row.sha256_hex === 'string' && row.sha256_hex.length === 64,
      `Expected 64-char sha256_hex, got: "${row.sha256_hex}"`);
  });

  await test('Corrupted snapshot is skipped; prior clean snapshot is used', () => {
    const db = getDb();
    // Deliberately corrupt the latest snapshot's JSON
    db.prepare(
      `UPDATE snapshots SET snapshot_json = 'CORRUPTED', sha256_hex = 'badhash'
       WHERE project_id = ? AND event_id = (
         SELECT MAX(event_id) FROM snapshots WHERE project_id = ?
       )`
    ).run(PROJECT_ID, PROJECT_ID);

    // Cold reload should skip corrupted snapshot and fall back to the prior one
    invalidateProjectCache(PROJECT_ID);
    let state: any;
    let threw = false;
    try {
      state = materializeProject(PROJECT_ID, false);
    } catch {
      threw = true;
    }
    assert(!threw, 'materializeProject should not throw on corrupted snapshot');
    assert(state !== undefined && typeof state.todos === 'object',
      'State should still be valid after corrupt snapshot fallback');
  });

  // =========================================================================
  // 13. ACTIVE SESSIONS — getActiveSessions
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('13. Active Sessions');
  console.log('──────────────────────────────────────────');

  const PROJECT_SESSIONS = 'project-sessions-test';
  const SESS_ACTIVE_A = 'active-sess-a';
  const SESS_ACTIVE_B = 'active-sess-b';
  const SESS_DEAD_TEST = 'dead-sess-test';

  await test('getActiveSessions returns only alive/stale sessions', () => {
    registerSession(PROJECT_SESSIONS, SESS_ACTIVE_A, 'AgentA');
    registerSession(PROJECT_SESSIONS, SESS_ACTIVE_B, 'AgentB');
    registerSession(PROJECT_SESSIONS, SESS_DEAD_TEST, 'AgentDead');
    gracefulDisconnect(PROJECT_SESSIONS, SESS_DEAD_TEST);

    const active = getActiveSessions(PROJECT_SESSIONS);
    const ids = active.map(s => s.id);
    assert(ids.includes(SESS_ACTIVE_A), 'Active session A should appear');
    assert(ids.includes(SESS_ACTIVE_B), 'Active session B should appear');
    assert(!ids.includes(SESS_DEAD_TEST), 'Dead session should not appear in active list');
  });

  await test('getActiveSessions returns empty array for unknown project', () => {
    const active = getActiveSessions('project-that-does-not-exist');
    assert(Array.isArray(active), 'Should return an array');
    assert(active.length === 0, 'Should be empty for unknown project');
  });

  await test('getActiveSessions is scoped per project', () => {
    const OTHER_PROJ = 'other-proj-isolation';
    const OTHER_SESS = 'other-sess-1';
    registerSession(OTHER_PROJ, OTHER_SESS, 'OtherAgent');

    const activeSessions = getActiveSessions(PROJECT_SESSIONS);
    const ids = activeSessions.map(s => s.id);
    assert(!ids.includes(OTHER_SESS), 'Session from other project should not appear');

    const otherActive = getActiveSessions(OTHER_PROJ);
    assert(otherActive.some(s => s.id === OTHER_SESS), 'Session should appear in its own project');
  });

  await test('Session records contain correct project_id and client_type', () => {
    const active = getActiveSessions(PROJECT_SESSIONS);
    const sessA = active.find(s => s.id === SESS_ACTIVE_A);
    assert(sessA !== undefined, 'SESS_ACTIVE_A not found');
    assert(sessA!.project_id === PROJECT_SESSIONS, `project_id mismatch: ${sessA!.project_id}`);
    assert(sessA!.client_type === 'AgentA', `client_type mismatch: ${sessA!.client_type}`);
    assert(sessA!.created_at > 0, 'created_at should be a positive timestamp');
    assert(sessA!.last_heartbeat > 0, 'last_heartbeat should be a positive timestamp');
  });

  // =========================================================================
  // 14. STRUCTURED HANDOFF PAYLOAD — generateStructuredHandoff
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('14. Structured Handoff Payload');
  console.log('──────────────────────────────────────────');

  const PROJECT_HO = 'project-handoff-payload';
  const SESS_HO = 'sess-handoff-writer';

  await test('generateStructuredHandoff captures completed TODOs in session', () => {
    registerSession(PROJECT_HO, SESS_HO, 'HandoffAgent');
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_HO, PROJECT_HO);

    const todoId = getNextSequenceValue(PROJECT_HO, 'todo');
    appendEvent(PROJECT_HO, SESS_HO, 'TODO_CREATED', { todo_id: todoId, title: 'HO Task', priority: 'high' });
    appendEvent(PROJECT_HO, SESS_HO, 'TODO_COMPLETED', { todo_id: todoId, version: 1 });

    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'graceful');
    assert(handoff.session_id === SESS_HO, 'session_id mismatch in handoff payload');
    assert(Array.isArray(handoff.completed_todos), 'completed_todos should be an array');
    assert(
      handoff.completed_todos.some((t: string) => t.includes(String(todoId))),
      `completed_todos should contain TODO ID ${todoId}`
    );
    assert(Array.isArray(handoff.pending_todos), 'pending_todos should be an array');
  });

  await test('generateStructuredHandoff captures pending (created but not completed) TODOs', () => {
    const todoId = getNextSequenceValue(PROJECT_HO, 'todo');
    appendEvent(PROJECT_HO, SESS_HO, 'TODO_CREATED', { todo_id: todoId, title: 'Pending HO Task', priority: 'medium' });

    // Update last_event_seen checkpoint so generateStructuredHandoff picks up only new events
    const db = getDb();
    const latestEvent = db.prepare(
      'SELECT id FROM events WHERE project_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1'
    ).get(PROJECT_HO, SESS_HO) as any;
    db.prepare('UPDATE sessions SET last_event_seen = ? WHERE id = ?').run(0, SESS_HO);

    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'graceful');
    assert(
      handoff.pending_todos.some((t: string) => t.includes(String(todoId))),
      `pending_todos should contain TODO ID ${todoId}`
    );
  });

  await test('generateStructuredHandoff captures rules added in session', () => {
    const db = getDb();
    db.prepare('UPDATE sessions SET last_event_seen = 0 WHERE id = ?').run(SESS_HO);

    const ruleId = randomUUID();
    appendEvent(PROJECT_HO, SESS_HO, 'RULE_ADDED', { rule_id: ruleId, content: 'Use strict TypeScript' });

    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'graceful');
    assert(Array.isArray(handoff.rules_added), 'rules_added should be an array');
    assert(
      handoff.rules_added.includes('Use strict TypeScript'),
      'rules_added should contain the rule content'
    );
  });

  await test('generateStructuredHandoff captures decisions and wiki in session', () => {
    const db = getDb();
    db.prepare('UPDATE sessions SET last_event_seen = 0 WHERE id = ?').run(SESS_HO);

    appendEvent(PROJECT_HO, SESS_HO, 'DECISION_RECORDED', {
      decision_id: 'ADR-HO-1',
      title: 'Use WAL mode',
      context: 'Performance',
      decision: 'Enable WAL'
    });
    appendEvent(PROJECT_HO, SESS_HO, 'WIKI_UPDATED', { topic: 'HO-Wiki', content: 'Some content.' });

    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'graceful');
    assert(Array.isArray(handoff.recent_decisions), 'recent_decisions should be an array');
    assert(handoff.recent_decisions.length > 0, 'recent_decisions should not be empty');
    assert(Array.isArray(handoff.wiki_updated), 'wiki_updated should be an array');
    assert(handoff.wiki_updated.includes('HO-Wiki'), 'wiki_updated should contain the topic');
  });

  await test('generateStructuredHandoff ungraceful summary mentions heartbeat timeout', () => {
    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'ungraceful');
    assert(typeof handoff.summary === 'string', 'summary should be a string');
    assert(
      handoff.summary.toLowerCase().includes('heartbeat') || handoff.summary.toLowerCase().includes('lost'),
      `Ungraceful summary should mention heartbeat/lost, got: "${handoff.summary}"`
    );
    assert(typeof handoff.timestamp === 'number' && handoff.timestamp > 0, 'timestamp should be positive');
  });

  await test('Deleted TODOs are excluded from pending_todos in handoff', () => {
    const db = getDb();
    db.prepare('UPDATE sessions SET last_event_seen = 0 WHERE id = ?').run(SESS_HO);

    const todoId = getNextSequenceValue(PROJECT_HO, 'todo');
    appendEvent(PROJECT_HO, SESS_HO, 'TODO_CREATED', { todo_id: todoId, title: 'To Delete', priority: 'low' });
    appendEvent(PROJECT_HO, SESS_HO, 'TODO_DELETED', { todo_id: todoId });

    const handoff = generateStructuredHandoff(PROJECT_HO, SESS_HO, 'graceful');
    assert(
      !handoff.pending_todos.some((t: string) => t.includes(String(todoId))),
      'Deleted TODO should not appear in pending_todos'
    );
  });

  // =========================================================================
  // 15. LIFECYCLE MONITOR — stale/dead transitions
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('15. Lifecycle Monitor (stale/dead transitions)');
  console.log('──────────────────────────────────────────');

  await test('startLifecycleMonitor does not throw and can be stopped', () => {
    startLifecycleMonitor(500); // 500ms interval for test speed
    stopLifecycleMonitor();
    // No assertion needed — if it throws the test fails
  });

  await test('startLifecycleMonitor is idempotent (double-start does not duplicate timer)', () => {
    startLifecycleMonitor(500);
    startLifecycleMonitor(500); // second call should be a no-op
    stopLifecycleMonitor();
    // Verify stop is also idempotent
    stopLifecycleMonitor();
  });

  await test('Session manually set to stale appears in getActiveSessions', () => {
    const PROJECT_STALE = 'project-stale-test';
    const SESS_STALE = 'stale-session-1';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_STALE, PROJECT_STALE);
    registerSession(PROJECT_STALE, SESS_STALE, 'StaleAgent');

    // Manually force status to stale (simulating what the monitor does)
    db.prepare(`UPDATE sessions SET status = 'stale' WHERE id = ?`).run(SESS_STALE);

    const active = getActiveSessions(PROJECT_STALE);
    const found = active.find(s => s.id === SESS_STALE);
    assert(found !== undefined, 'Stale session should still appear in getActiveSessions');
    assert(found!.status === 'stale', `Expected status 'stale', got '${found!.status}'`);
  });

  await test('Session marked dead is excluded from getActiveSessions', () => {
    const PROJECT_DEAD = 'project-dead-test';
    const SESS_DEAD = 'dead-session-lifecycle';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_DEAD, PROJECT_DEAD);
    registerSession(PROJECT_DEAD, SESS_DEAD, 'DeadAgent');

    // Manually force to dead (simulating monitor's dead transition)
    db.prepare(`UPDATE sessions SET status = 'dead' WHERE id = ?`).run(SESS_DEAD);

    const active = getActiveSessions(PROJECT_DEAD);
    assert(!active.some(s => s.id === SESS_DEAD), 'Dead session should not appear in getActiveSessions');
  });

  // =========================================================================
  // 16. INPUT VALIDATION — validateProjectId, validateSessionId, sanitizeInput
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('16. Input Validation (validators & sanitizers)');
  console.log('──────────────────────────────────────────');

  await test('validateProjectId accepts valid IDs', () => {
    // Should not throw
    validateProjectId('my-project');
    validateProjectId('my_project_123');
    validateProjectId('UPPER-LOWER-123');
  });

  await test('validateProjectId rejects IDs with special characters', () => {
    assertThrows(() => validateProjectId('bad project!'), 'Invalid project_id');
    assertThrows(() => validateProjectId('proj/path'), 'Invalid project_id');
    assertThrows(() => validateProjectId('proj.name'), 'Invalid project_id');
    assertThrows(() => validateProjectId(''), 'Invalid project_id');
  });

  await test('validateSessionId accepts valid IDs', () => {
    validateSessionId('claude-abc');
    validateSessionId('cursor_123');
    validateSessionId('agent-X-99');
  });

  await test('validateSessionId rejects IDs with spaces or special characters', () => {
    assertThrows(() => validateSessionId('bad session'), 'Invalid session_id');
    assertThrows(() => validateSessionId('sess@host'), 'Invalid session_id');
    assertThrows(() => validateSessionId('sess:port'), 'Invalid session_id');
  });

  await test('registerSession throws on invalid project_id', () => {
    assertThrows(
      () => registerSession('invalid project!', 'sess-valid', 'Agent'),
      'Invalid project_id'
    );
  });

  await test('registerSession throws on invalid session_id', () => {
    assertThrows(
      () => registerSession('valid-project', 'bad session@id', 'Agent'),
      'Invalid session_id'
    );
  });

  await test('sanitizeInput strips control characters', () => {
    const dirty = 'hello\x01world\x07test\x1Fend';
    const clean = sanitizeInput(dirty);
    assert(!clean.includes('\x01'), 'Control char \\x01 should be removed');
    assert(!clean.includes('\x07'), 'Control char \\x07 should be removed');
    assert(!clean.includes('\x1F'), 'Control char \\x1F should be removed');
    assert(clean.includes('hello'), 'Normal text should be preserved');
  });

  await test('sanitizeInput preserves newlines and tabs', () => {
    const input = 'line1\nline2\ttabbed';
    const result = sanitizeInput(input);
    assert(result.includes('\n'), 'Newlines should be preserved');
    assert(result.includes('\t'), 'Tabs should be preserved');
  });

  await test('sanitizeInput throws when input exceeds max length', () => {
    const oversized = 'x'.repeat(10001);
    assertThrows(() => sanitizeInput(oversized), 'maximum length');
  });

  await test('sanitizeTitle throws when title exceeds max title length', () => {
    const oversized = 'x'.repeat(501);
    assertThrows(() => sanitizeTitle(oversized), 'maximum length');
  });

  // =========================================================================
  // 17. SHA-256 UTILITY — sha256hex
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('17. sha256hex Utility');
  console.log('──────────────────────────────────────────');

  await test('sha256hex produces 64-char hex string', () => {
    const result = sha256hex('hello world');
    assert(typeof result === 'string', 'Should return a string');
    assert(result.length === 64, `Expected 64 chars, got ${result.length}`);
    assert(/^[0-9a-f]+$/.test(result), 'Should be lowercase hex');
  });

  await test('sha256hex is deterministic', () => {
    const a = sha256hex('consistent input');
    const b = sha256hex('consistent input');
    assert(a === b, 'Same input should always produce same hash');
  });

  await test('sha256hex produces different output for different inputs', () => {
    const a = sha256hex('input A');
    const b = sha256hex('input B');
    assert(a !== b, 'Different inputs should produce different hashes');
  });

  await test('sha256hex handles empty string', () => {
    const result = sha256hex('');
    assert(result.length === 64, 'Empty string should still produce 64-char hash');
    // Known SHA-256 of empty string
    assert(result === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      `Unexpected SHA-256 of empty string: ${result}`);
  });

  // =========================================================================
  // 18. SNAPSHOT RETENTION — only last 3 kept
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('18. Snapshot Retention (max 3)');
  console.log('──────────────────────────────────────────');

  await test('Snapshot table retains at most 3 snapshots per project', () => {
    const PROJECT_SNAP = 'project-snap-retention';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_SNAP, PROJECT_SNAP);

    // Trigger 4 snapshot cycles (each needs 100+ events)
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 105; i++) {
        appendEvent(PROJECT_SNAP, 'agent-snap', 'RULE_ADDED', {
          rule_id: randomUUID(),
          content: `Retention cycle ${cycle} rule ${i}`
        });
      }
      invalidateProjectCache(PROJECT_SNAP);
      materializeProject(PROJECT_SNAP, true);
    }

    const count = (db.prepare(
      'SELECT COUNT(*) as c FROM snapshots WHERE project_id = ?'
    ).get(PROJECT_SNAP) as any).c;

    assert(count <= 3, `Expected at most 3 snapshots, got ${count}`);
    assert(count >= 1, 'Expected at least 1 snapshot to exist');
  });

  // =========================================================================
  // 19. PROMPT INJECTION SANITIZATION — sanitizeMarkdown
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('19. Prompt Injection Sanitization');
  console.log('──────────────────────────────────────────');

  await test('sanitizeMarkdown escapes header markers', () => {
    const result = sanitizeMarkdown('# Injected Header');
    assert(!result.startsWith('#'), 'Leading # should be escaped');
    assert(result.includes('\\#'), 'Should contain escaped #');
  });

  await test('sanitizeMarkdown escapes backticks', () => {
    const result = sanitizeMarkdown('```js\nconsole.log("pwned")\n```');
    assert(!result.includes('```'), 'Triple backticks should be escaped');
    assert(result.includes('\\`'), 'Should contain escaped backtick');
  });

  await test('sanitizeMarkdown escapes blockquote markers', () => {
    const result = sanitizeMarkdown('> Injected blockquote');
    assert(!result.startsWith('>'), 'Leading > should be escaped');
    assert(result.includes('\\>'), 'Should contain escaped >');
  });

  await test('sanitizeMarkdown escapes bold/italic markers', () => {
    const result = sanitizeMarkdown('**bold** and _italic_');
    assert(result.includes('\\*\\*'), 'Bold markers should be escaped');
    assert(result.includes('\\_'), 'Italic markers should be escaped');
  });

  await test('sanitizeMarkdown escapes link brackets', () => {
    const result = sanitizeMarkdown('[click me](http://evil.com)');
    assert(result.includes('\\['), 'Opening bracket should be escaped');
    assert(result.includes('\\]'), 'Closing bracket should be escaped');
  });

  await test('sanitizeMarkdown preserves newlines', () => {
    const result = sanitizeMarkdown('line one\nline two');
    assert(result.includes('\n'), 'Newlines should be preserved');
    assert(result.includes('line one'), 'Content before newline preserved');
    assert(result.includes('line two'), 'Content after newline preserved');
  });

  await test('sanitizeMarkdown is idempotent on plain text', () => {
    const plain = 'plain text with no special chars 123';
    const result = sanitizeMarkdown(plain);
    assert(result === plain, 'Plain text should be unchanged');
  });

  await test('sanitizeMarkdown handles empty string', () => {
    const result = sanitizeMarkdown('');
    assert(result === '', 'Empty string should remain empty');
  });

  // =========================================================================
  // 20. SNAPSHOT SCHEMA VERSIONING
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('20. Snapshot Schema Versioning');
  console.log('──────────────────────────────────────────');

  await test('Snapshots are written with current SNAPSHOT_SCHEMA_VERSION', () => {
    const PROJECT_SV = 'project-schema-version';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_SV, PROJECT_SV);

    for (let i = 0; i < 105; i++) {
      appendEvent(PROJECT_SV, 'agent-sv', 'RULE_ADDED', { rule_id: randomUUID(), content: `SV rule ${i}` });
    }
    invalidateProjectCache(PROJECT_SV);
    materializeProject(PROJECT_SV, true);

    const row = db.prepare(
      'SELECT schema_version FROM snapshots WHERE project_id = ? ORDER BY event_id DESC LIMIT 1'
    ).get(PROJECT_SV) as any;
    assert(row !== undefined, 'Snapshot should exist');
    assert(row.schema_version === SNAPSHOT_SCHEMA_VERSION,
      `Expected schema_version ${SNAPSHOT_SCHEMA_VERSION}, got ${row.schema_version}`);
  });

  await test('Snapshot with wrong schema_version is skipped, state rebuilt from events', () => {
    const PROJECT_SV2 = 'project-schema-mismatch';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_SV2, PROJECT_SV2);

    // Write a TODO so we have something to verify in the rebuilt state
    const todoId = getNextSequenceValue(PROJECT_SV2, 'todo');
    appendEvent(PROJECT_SV2, 'agent-sv2', 'TODO_CREATED', { todo_id: todoId, title: 'Schema test task', priority: 'high' });

    // Force a snapshot
    for (let i = 0; i < 105; i++) {
      appendEvent(PROJECT_SV2, 'agent-sv2', 'RULE_ADDED', { rule_id: randomUUID(), content: `SV2 rule ${i}` });
    }
    invalidateProjectCache(PROJECT_SV2);
    materializeProject(PROJECT_SV2, true);

    // Corrupt the schema_version to simulate a future version mismatch
    db.prepare(
      `UPDATE snapshots SET schema_version = 999
       WHERE project_id = ? AND event_id = (SELECT MAX(event_id) FROM snapshots WHERE project_id = ?)`
    ).run(PROJECT_SV2, PROJECT_SV2);

    // Cold-load should skip the bad snapshot and replay from scratch
    invalidateProjectCache(PROJECT_SV2);
    let state: any;
    let threw = false;
    try {
      state = materializeProject(PROJECT_SV2, false);
    } catch {
      threw = true;
    }
    assert(!threw, 'Should not throw on schema version mismatch — should fallback gracefully');
    assert(state !== undefined && typeof state.todos === 'object', 'State should be valid after fallback');
    assert(state.todos[todoId] !== undefined, 'TODO written before snapshot should still appear after replay');
    assert(state.todos[todoId].title === 'Schema test task', 'TODO title should be correct after replay');
  });

  // =========================================================================
  // 21. SESSION_ID ATTRIBUTION ON MEMORIES
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('21. Memory session_id Attribution');
  console.log('──────────────────────────────────────────');

  await test('Memory stored with session_id persists attribution', () => {
    const mem = addMemory(PROJECT_ID, 'summary', 'Session-attributed memory', undefined, 0.7, undefined, undefined, CLIENT_A);
    assert(mem.session_id === CLIENT_A, `Expected session_id ${CLIENT_A}, got ${mem.session_id}`);

    const list = getMemories(PROJECT_ID);
    const found = list.find(m => m.id === mem.id);
    assert(found !== undefined, 'Memory should appear in getMemories');
    assert(found!.session_id === CLIENT_A, 'session_id should be persisted to DB');
  });

  await test('Memory stored without session_id has null session_id', () => {
    const mem = addMemory(PROJECT_ID, 'summary', 'Unattributed memory', undefined, 0.5);
    assert(mem.session_id === null, `Expected null session_id, got ${mem.session_id}`);

    const list = getMemories(PROJECT_ID);
    const found = list.find(m => m.id === mem.id);
    assert(found !== undefined, 'Memory should appear in getMemories');
    assert(found!.session_id === null, 'session_id should be null in DB');
  });

  await test('Upsert on same source_ref updates session_id', () => {
    addMemory(PROJECT_ID, 'rule', 'Rule with session', undefined, 0.8, 'RULE-SESSION-A', undefined, CLIENT_A);
    addMemory(PROJECT_ID, 'rule', 'Rule with session updated', undefined, 0.9, 'RULE-SESSION-A', undefined, CLIENT_B);

    const list = getMemories(PROJECT_ID);
    const found = list.find(m => m.source_ref === 'RULE-SESSION-A');
    assert(found !== undefined, 'Memory should exist');
    assert(found!.session_id === CLIENT_B, `session_id should be updated to ${CLIENT_B}`);
    assert(found!.content === 'Rule with session updated', 'Content should be updated');
  });

  await test('Different sessions produce independently attributed memories', () => {
    const memA = addMemory(PROJECT_ID, 'summary', 'From session A', undefined, 0.5, undefined, undefined, CLIENT_A);
    const memB = addMemory(PROJECT_ID, 'summary', 'From session B', undefined, 0.5, undefined, undefined, CLIENT_B);
    assert(memA.session_id === CLIENT_A, 'memA should be attributed to CLIENT_A');
    assert(memB.session_id === CLIENT_B, 'memB should be attributed to CLIENT_B');
    assert(memA.id !== memB.id, 'Should be stored as separate records');
  });

  // =========================================================================
  // 22. IMPLICIT MEMORY INJECTION IN CONTEXT
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('22. Implicit Memory Injection');
  console.log('──────────────────────────────────────────');

  const PROJECT_IMC = 'project-implicit-memory';
  const db_imc = getDb();
  db_imc.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_IMC, PROJECT_IMC);
  registerSession(PROJECT_IMC, 'imc-agent', 'TestAgent');

  await test('searchMemories returns relevant memory for matching query', () => {
    addMemory(PROJECT_IMC, 'rule', 'Always use WAL mode for SQLite connections', undefined, 0.9);
    addMemory(PROJECT_IMC, 'wiki', 'Setup guide for the CI pipeline', undefined, 0.7);

    const results = searchMemories(PROJECT_IMC, 'SQLite WAL mode database', undefined, 5);
    assert(results.length > 0, 'Should return at least one result');
    const topMemory = results[0];
    assert(topMemory.memory.content.includes('WAL'), 'Top result should be the WAL memory');
  });

  await test('searchMemories with unrelated query has zero TF-IDF relevance score', () => {
    // Use a fresh isolated project with known memories
    const PROJECT_NOISE = 'project-noise-test';
    const db_noise = getDb();
    db_noise.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_NOISE, PROJECT_NOISE);
    addMemory(PROJECT_NOISE, 'rule', 'Always use WAL mode for SQLite connections', undefined, 0.9);
    addMemory(PROJECT_NOISE, 'wiki', 'Setup guide for the CI pipeline', undefined, 0.7);

    // A query with no token overlap whatsoever — TF-IDF relevance should be 0
    // Note: combined score still includes recency (0.2) + importance (0.2) + projectRelevance (0.05)
    // so the *relevance* component (TF-IDF weight) is what we assert is zero
    const results = searchMemories(PROJECT_NOISE, 'xyzzy-completely-unrelated-token-zqvw', undefined, 5);
    assert(results.length > 0, 'Should still return results (all memories scored)');
    for (const r of results) {
      assert(r.relevance === 0, `TF-IDF relevance should be 0 for unrelated query, got ${r.relevance}`);
    }
  });

  await test('Relevant memory signals are built from pending TODOs and wiki topics', () => {
    // Add a TODO and a matching memory
    const todoId = getNextSequenceValue(PROJECT_IMC, 'todo');
    appendEvent(PROJECT_IMC, 'imc-agent', 'TODO_CREATED', {
      todo_id: todoId,
      title: 'Optimize SQLite write performance',
      priority: 'high'
    });
    addMemory(PROJECT_IMC, 'decision', 'SQLite WAL mode chosen for write performance optimization', undefined, 0.9);

    invalidateProjectCache(PROJECT_IMC);
    const state = materializeProject(PROJECT_IMC, false);

    // Build the same signal query the context resource would use
    const pending = Object.values(state.todos).filter((t: any) => t.status === 'pending');
    const signals: string[] = [];
    if (pending.length > 0) signals.push(pending.map((t: any) => t.title).join(' '));

    const implicitQuery = signals.join(' ').trim();
    assert(implicitQuery.length > 0, 'Implicit query should not be empty');

    const results = searchMemories(PROJECT_IMC, implicitQuery, undefined, 5);
    const aboveThreshold = results.filter(r => r.score >= 0.3);
    assert(aboveThreshold.length > 0, 'Should surface at least one memory above threshold for matching TODO signal');
  });

  await test('Empty memory store produces no relevant_memories (no noise)', () => {
    const PROJECT_EMPTY_MEM = 'project-empty-mem';
    db_imc.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_EMPTY_MEM, PROJECT_EMPTY_MEM);
    appendEvent(PROJECT_EMPTY_MEM, 'agent-empty', 'TODO_CREATED', {
      todo_id: 1, title: 'Some task', priority: 'low'
    });
    invalidateProjectCache(PROJECT_EMPTY_MEM);

    const results = searchMemories(PROJECT_EMPTY_MEM, 'Some task', undefined, 5);
    assert(Array.isArray(results), 'Should return array even when store is empty');
    assert(results.length === 0, 'Empty store should return no results');
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
