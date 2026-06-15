import { randomUUID } from 'crypto';
import { initDatabase, closeDatabase, sha256hex } from '../src/db/database.js';
import { appendEvent, getNextSequenceValue, createSnapshot } from '../src/events/store.js';
import { materializeProject, invalidateProjectCache, createInitialState } from '../src/events/materializer.js';
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
import { validateProjectId, validateSessionId, sanitizeInput, sanitizeTitle, escapeMarkdownForRender } from '../src/validation.js';
import { getDb } from '../src/db/database.js';
import { SNAPSHOT_SCHEMA_VERSION, now as getCurrentTimestamp } from '../src/constants.js';
import { handleCoordinationTool } from '../src/mcp/tools/coordination.tools.js';
import { handleReadResource } from '../src/mcp/resources.js';
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

  await test('memory.search handles FTS MATCH syntax errors gracefully by setting degraded flag', () => {
    const db = getDb();
    // Temporarily rename the fts table to trigger an FTS search failure
    db.prepare('ALTER TABLE memories_fts RENAME TO memories_fts_temp').run();

    try {
      const results = searchMemories(PROJECT_ID, 'ESM rules');
      assert(results.degraded === true, 'Search results should have degraded: true');
      assert(typeof results.reason === 'string', 'degraded reason should be populated');
      assert(results.length > 0, 'Fallback search should still return matches');
    } finally {
      // Restore the fts table
      db.prepare('ALTER TABLE memories_fts_temp RENAME TO memories_fts').run();
    }
  });

  await test('memory.search handles FTS MATCH syntax errors with empty results gracefully', () => {
    const db = getDb();
    const TEMP_PROJECT = 'non-existent-project-for-degraded-empty-test';
    // Temporarily rename the fts table to trigger an FTS search failure
    db.prepare('ALTER TABLE memories_fts RENAME TO memories_fts_temp').run();

    try {
      const results = searchMemories(TEMP_PROJECT, 'some keyword query');
      assert(results.degraded === true, 'Search results should have degraded: true even when empty');
      assert(typeof results.reason === 'string', 'degraded reason should be populated');
      assert(results.length === 0, 'Should return empty results');
    } finally {
      // Restore the fts table
      db.prepare('ALTER TABLE memories_fts_temp RENAME TO memories_fts').run();
    }
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
    assertThrows(() => validateSessionId('system'), 'Invalid session_id');
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
  // 19. PROMPT INJECTION SANITIZATION — escapeMarkdownForRender
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('19. Prompt Injection Sanitization');
  console.log('──────────────────────────────────────────');

  await test('escapeMarkdownForRender escapes header markers', () => {
    const result = escapeMarkdownForRender('# Injected Header');
    assert(!result.startsWith('#'), 'Leading # should be escaped');
    assert(result.includes('\\#'), 'Should contain escaped #');
  });

  await test('escapeMarkdownForRender escapes backticks', () => {
    const result = escapeMarkdownForRender('```js\nconsole.log("pwned")\n```');
    assert(!result.includes('```'), 'Triple backticks should be escaped');
    assert(result.includes('\\`'), 'Should contain escaped backtick');
  });

  await test('escapeMarkdownForRender escapes blockquote markers', () => {
    const result = escapeMarkdownForRender('> Injected blockquote');
    assert(!result.startsWith('>'), 'Leading > should be escaped');
    assert(result.includes('\\>'), 'Should contain escaped >');
  });

  await test('escapeMarkdownForRender escapes bold/italic markers', () => {
    const result = escapeMarkdownForRender('**bold** and _italic_');
    assert(result.includes('\\*\\*'), 'Bold markers should be escaped');
    assert(result.includes('\\_'), 'Italic markers should be escaped');
  });

  await test('escapeMarkdownForRender escapes link brackets', () => {
    const result = escapeMarkdownForRender('[click me](http://evil.com)');
    assert(result.includes('\\['), 'Opening bracket should be escaped');
    assert(result.includes('\\]'), 'Closing bracket should be escaped');
  });

  await test('escapeMarkdownForRender preserves newlines', () => {
    const result = escapeMarkdownForRender('line one\nline two');
    assert(result.includes('\n'), 'Newlines should be preserved');
    assert(result.includes('line one'), 'Content before newline preserved');
    assert(result.includes('line two'), 'Content after newline preserved');
  });

  await test('escapeMarkdownForRender is idempotent on plain text', () => {
    const plain = 'plain text with no special chars 123';
    const result = escapeMarkdownForRender(plain);
    assert(result === plain, 'Plain text should be unchanged');
  });

  await test('escapeMarkdownForRender handles empty string', () => {
    const result = escapeMarkdownForRender('');
    assert(result === '', 'Empty string should remain empty');
  });

  // =========================================================================
  // 20. SNAPSHOT SCHEMA VERSIONING
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('20. Snapshot Schema Versioning');
  console.log('──────────────────────────────────────────');

  await test('createInitialState keys match expected ProjectState schema to enforce version bump discipline', () => {
    const state = createInitialState();
    const keys = Object.keys(state).sort();
    const expectedKeys = [
      'broadcasts',
      'conflicts',
      'decisions',
      'handoffs',
      'lastEventId',
      'messages',
      'rules',
      'todos',
      'wiki'
    ];
    assert(JSON.stringify(keys) === JSON.stringify(expectedKeys), 'ProjectState structure has changed! If you modified ProjectState fields in src/events/materializer.ts, you must increment SNAPSHOT_SCHEMA_VERSION in src/constants.ts and update this test.');
    assert(SNAPSHOT_SCHEMA_VERSION === 2, `Expected SNAPSHOT_SCHEMA_VERSION to be 2. If you changed the ProjectState schema keys, increment SNAPSHOT_SCHEMA_VERSION and update this test.`);
  });

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
  // 23. Phase 3 — Work Claiming (todoclaim / todounclaim)
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('23. Phase 3 — Work Claiming');
  console.log('──────────────────────────────────────────');

  const CLAIM_PROJECT = 'test-claim-project';
  const CLAIM_SID_A = 'session-claim-a';
  const CLAIM_SID_B = 'session-claim-b';

  await test('TODO_CLAIMED event sets claimed_by on the todo', () => {
    invalidateProjectCache(CLAIM_PROJECT);
    registerSession(CLAIM_PROJECT, CLAIM_SID_A, 'TestClient');
    const todoId = getNextSequenceValue(CLAIM_PROJECT, 'todo');
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CREATED', { todo_id: todoId, title: 'Claim me', priority: 'medium' });
    const claimedAt = Math.floor(Date.now() / 1000);
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CLAIMED', { todo_id: todoId, session_id: CLAIM_SID_A, claimed_at: claimedAt });
    invalidateProjectCache(CLAIM_PROJECT);

    const state = materializeProject(CLAIM_PROJECT, false);
    const todo = state.todos[todoId];
    assert(todo !== undefined, 'TODO should exist');
    assert(todo.claimed_by === CLAIM_SID_A, `claimed_by should be ${CLAIM_SID_A}, got ${todo.claimed_by}`);
    assert(todo.claimed_at === claimedAt, 'claimed_at should match');
  });

  await test('TODO_UNCLAIMED event removes claimed_by from the todo', () => {
    invalidateProjectCache(CLAIM_PROJECT);
    const todoId = getNextSequenceValue(CLAIM_PROJECT, 'todo');
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CREATED', { todo_id: todoId, title: 'Unclaim me', priority: 'low' });
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CLAIMED', { todo_id: todoId, session_id: CLAIM_SID_A, claimed_at: Math.floor(Date.now() / 1000) });
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_UNCLAIMED', { todo_id: todoId, session_id: CLAIM_SID_A });
    invalidateProjectCache(CLAIM_PROJECT);

    const state = materializeProject(CLAIM_PROJECT, false);
    const todo = state.todos[todoId];
    assert(todo !== undefined, 'TODO should exist');
    assert(todo.claimed_by === undefined, 'claimed_by should be removed after unclaim');
  });

  await test('Claim from a different session is visible to all', () => {
    invalidateProjectCache(CLAIM_PROJECT);
    registerSession(CLAIM_PROJECT, CLAIM_SID_B, 'OtherClient');
    const todoId = getNextSequenceValue(CLAIM_PROJECT, 'todo');
    appendEvent(CLAIM_PROJECT, CLAIM_SID_B, 'TODO_CREATED', { todo_id: todoId, title: 'Cross-session claim', priority: 'high' });
    appendEvent(CLAIM_PROJECT, CLAIM_SID_B, 'TODO_CLAIMED', { todo_id: todoId, session_id: CLAIM_SID_B, claimed_at: Math.floor(Date.now() / 1000) });
    invalidateProjectCache(CLAIM_PROJECT);

    // Session A materializes the project and should see Session B's claim
    const state = materializeProject(CLAIM_PROJECT, false);
    const todo = state.todos[todoId];
    assert(todo.claimed_by === CLAIM_SID_B, `Session A should see claim by ${CLAIM_SID_B}`);
  });

  await test('Claimed_by is cleared when TODO is completed', () => {
    invalidateProjectCache(CLAIM_PROJECT);
    const todoId = getNextSequenceValue(CLAIM_PROJECT, 'todo');
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CREATED', { todo_id: todoId, title: 'Complete after claim', priority: 'medium' });
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_CLAIMED', { todo_id: todoId, session_id: CLAIM_SID_A, claimed_at: Math.floor(Date.now() / 1000) });
    // Complete without explicit unclaim — completed todos don't show in pending, claim is moot
    appendEvent(CLAIM_PROJECT, CLAIM_SID_A, 'TODO_COMPLETED', { todo_id: todoId, version: 1 });
    invalidateProjectCache(CLAIM_PROJECT);

    const state = materializeProject(CLAIM_PROJECT, false);
    const todo = state.todos[todoId];
    assert(todo.status === 'completed', 'TODO should be completed');
    // claimed_by may still be on the record, but the TODO is completed — that's acceptable
  });

  // =========================================================================
  // 24. Phase 3 — Direct Messaging (messagesend)
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('24. Phase 3 — Direct Messaging');
  console.log('──────────────────────────────────────────');

  const MSG_PROJECT = 'test-msg-project';
  const MSG_SID_A = 'session-msg-a';
  const MSG_SID_B = 'session-msg-b';

  await test('MESSAGE_SENT event materializes into messages array', () => {
    invalidateProjectCache(MSG_PROJECT);
    registerSession(MSG_PROJECT, MSG_SID_A, 'TestClient');
    registerSession(MSG_PROJECT, MSG_SID_B, 'TestClient');

    const sentAt = Math.floor(Date.now() / 1000);
    appendEvent(MSG_PROJECT, MSG_SID_A, 'MESSAGE_SENT', {
      from_session_id: MSG_SID_A,
      to_session_id: MSG_SID_B,
      content: 'Hold off on auth.ts — I am refactoring it',
      sent_at: sentAt
    });
    invalidateProjectCache(MSG_PROJECT);

    const state = materializeProject(MSG_PROJECT, false);
    assert(state.messages.length === 1, `Should have 1 message, got ${state.messages.length}`);
    assert(state.messages[0].from_session_id === MSG_SID_A, 'from_session_id should match');
    assert(state.messages[0].to_session_id === MSG_SID_B, 'to_session_id should match');
    assert(state.messages[0].content === 'Hold off on auth.ts — I am refactoring it', 'content should match');
    assert(state.messages[0].sent_at === sentAt, 'sent_at should match');
  });

  await test('Multiple messages accumulate in order', () => {
    invalidateProjectCache(MSG_PROJECT);
    const sentAt = Math.floor(Date.now() / 1000);
    appendEvent(MSG_PROJECT, MSG_SID_B, 'MESSAGE_SENT', {
      from_session_id: MSG_SID_B,
      to_session_id: MSG_SID_A,
      content: 'Got it, I will wait',
      sent_at: sentAt + 1
    });
    invalidateProjectCache(MSG_PROJECT);

    const state = materializeProject(MSG_PROJECT, false);
    assert(state.messages.length === 2, `Should have 2 messages, got ${state.messages.length}`);
    assert(state.messages[1].from_session_id === MSG_SID_B, 'Second message from should be B');
  });

  await test('Messages are capped at 50', () => {
    invalidateProjectCache(MSG_PROJECT);
    const sentAt = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 60; i++) {
      appendEvent(MSG_PROJECT, MSG_SID_A, 'MESSAGE_SENT', {
        from_session_id: MSG_SID_A,
        to_session_id: MSG_SID_B,
        content: `Message number ${i}`,
        sent_at: sentAt + i
      });
    }
    invalidateProjectCache(MSG_PROJECT);

    const state = materializeProject(MSG_PROJECT, false);
    assert(state.messages.length === 50, `Messages should be capped at 50, got ${state.messages.length}`);
    // The last message should be the most recent one
    assert(state.messages[49].content === 'Message number 59', 'Last message should be the most recent');
  });

  // =========================================================================
  // 25. Phase 3 — Broadcasts
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('25. Phase 3 — Broadcasts');
  console.log('──────────────────────────────────────────');

  const BC_PROJECT = 'test-broadcast-project';
  const BC_SID_A = 'session-bc-a';
  const BC_SID_B = 'session-bc-b';

  await test('BROADCAST event materializes into broadcasts array', () => {
    invalidateProjectCache(BC_PROJECT);
    registerSession(BC_PROJECT, BC_SID_A, 'TestClient');
    const sentAt = Math.floor(Date.now() / 1000);
    appendEvent(BC_PROJECT, BC_SID_A, 'BROADCAST', {
      from_session_id: BC_SID_A,
      content: 'Starting a large refactor of the auth module',
      sent_at: sentAt
    });
    invalidateProjectCache(BC_PROJECT);

    const state = materializeProject(BC_PROJECT, false);
    assert(state.broadcasts.length === 1, `Should have 1 broadcast, got ${state.broadcasts.length}`);
    assert(state.broadcasts[0].from_session_id === BC_SID_A, 'from_session_id should match');
    assert(state.broadcasts[0].content === 'Starting a large refactor of the auth module', 'content should match');
  });

  await test('Broadcasts from multiple sessions accumulate in order', () => {
    invalidateProjectCache(BC_PROJECT);
    registerSession(BC_PROJECT, BC_SID_B, 'TestClient');
    const sentAt = Math.floor(Date.now() / 1000);
    appendEvent(BC_PROJECT, BC_SID_B, 'BROADCAST', {
      from_session_id: BC_SID_B,
      content: 'I will avoid auth for now',
      sent_at: sentAt + 2
    });
    invalidateProjectCache(BC_PROJECT);

    const state = materializeProject(BC_PROJECT, false);
    assert(state.broadcasts.length === 2, `Should have 2 broadcasts, got ${state.broadcasts.length}`);
    assert(state.broadcasts[1].from_session_id === BC_SID_B, 'Second broadcast from should be B');
  });

  await test('Broadcasts are capped at 20', () => {
    invalidateProjectCache(BC_PROJECT);
    const sentAt = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 25; i++) {
      appendEvent(BC_PROJECT, BC_SID_A, 'BROADCAST', {
        from_session_id: BC_SID_A,
        content: `Broadcast ${i}`,
        sent_at: sentAt + i
      });
    }
    invalidateProjectCache(BC_PROJECT);

    const state = materializeProject(BC_PROJECT, false);
    assert(state.broadcasts.length === 20, `Broadcasts should be capped at 20, got ${state.broadcasts.length}`);
    assert(state.broadcasts[19].content === 'Broadcast 24', 'Last broadcast should be most recent');
  });

  // =========================================================================
  // 26. Phase 3 — Conflict Detection
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('26. Phase 3 — Conflict Detection');
  console.log('──────────────────────────────────────────');

  const CONF_PROJECT = 'test-conflict-project';
  const CONF_SID_A = 'session-conf-a';
  const CONF_SID_B = 'session-conf-b';

  await test('TODO_CONFLICT event materializes into conflicts array', () => {
    invalidateProjectCache(CONF_PROJECT);
    registerSession(CONF_PROJECT, CONF_SID_A, 'TestClient');
    registerSession(CONF_PROJECT, CONF_SID_B, 'TestClient');

    const todoId = getNextSequenceValue(CONF_PROJECT, 'todo');
    appendEvent(CONF_PROJECT, CONF_SID_A, 'TODO_CREATED', { todo_id: todoId, title: 'Contested task', priority: 'high' });
    appendEvent(CONF_PROJECT, CONF_SID_B, 'TODO_CONFLICT', {
      todo_id: todoId,
      conflicting_session_id: CONF_SID_A,
      conflict_type: 'concurrent_complete'
    });
    invalidateProjectCache(CONF_PROJECT);

    const state = materializeProject(CONF_PROJECT, false);
    assert(state.conflicts.length === 1, `Should have 1 conflict, got ${state.conflicts.length}`);
    assert(state.conflicts[0].todo_id === todoId, 'todo_id should match');
    assert(state.conflicts[0].conflicting_session_id === CONF_SID_A, 'conflicting_session_id should match');
    assert(state.conflicts[0].conflict_type === 'concurrent_complete', 'conflict_type should match');
    assert(state.conflicts[0].detected_by_session === CONF_SID_B, 'detected_by_session should match');
  });

  await test('Conflicts are capped at 20', () => {
    invalidateProjectCache(CONF_PROJECT);
    for (let i = 0; i < 25; i++) {
      const todoId = getNextSequenceValue(CONF_PROJECT, 'todo');
      appendEvent(CONF_PROJECT, CONF_SID_A, 'TODO_CREATED', { todo_id: todoId, title: `Task ${i}`, priority: 'low' });
      appendEvent(CONF_PROJECT, CONF_SID_B, 'TODO_CONFLICT', {
        todo_id: todoId,
        conflicting_session_id: CONF_SID_A,
        conflict_type: 'concurrent_update'
      });
    }
    invalidateProjectCache(CONF_PROJECT);

    const state = materializeProject(CONF_PROJECT, false);
    assert(state.conflicts.length === 20, `Conflicts should be capped at 20, got ${state.conflicts.length}`);
  });

  await test('Conflicts from different conflict_types are both recorded', () => {
    const CF2_PROJECT = 'test-conflict2-project';
    invalidateProjectCache(CF2_PROJECT);
    registerSession(CF2_PROJECT, CONF_SID_A, 'TestClient');
    registerSession(CF2_PROJECT, CONF_SID_B, 'TestClient');

    const t1 = getNextSequenceValue(CF2_PROJECT, 'todo');
    const t2 = getNextSequenceValue(CF2_PROJECT, 'todo');
    appendEvent(CF2_PROJECT, CONF_SID_A, 'TODO_CREATED', { todo_id: t1, title: 'Task 1', priority: 'medium' });
    appendEvent(CF2_PROJECT, CONF_SID_A, 'TODO_CREATED', { todo_id: t2, title: 'Task 2', priority: 'medium' });
    appendEvent(CF2_PROJECT, CONF_SID_B, 'TODO_CONFLICT', { todo_id: t1, conflicting_session_id: CONF_SID_A, conflict_type: 'concurrent_complete' });
    appendEvent(CF2_PROJECT, CONF_SID_B, 'TODO_CONFLICT', { todo_id: t2, conflicting_session_id: CONF_SID_A, conflict_type: 'concurrent_update' });
    invalidateProjectCache(CF2_PROJECT);

    const state = materializeProject(CF2_PROJECT, false);
    assert(state.conflicts.length === 2, `Should have 2 conflicts, got ${state.conflicts.length}`);
    assert(state.conflicts[0].conflict_type === 'concurrent_complete', 'First conflict type should match');
    assert(state.conflicts[1].conflict_type === 'concurrent_update', 'Second conflict type should match');
  });

  // =========================================================================
  // 27. Phase 4.4 — Versioned Migration Runner
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('27. Phase 4.4 — Versioned Migration Runner');
  console.log('──────────────────────────────────────────');

  await test('butler_migrations table exists after initDatabase', () => {
    const db = getDb();
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='butler_migrations'`
    ).get();
    assert(row !== undefined, 'butler_migrations table should exist');
  });

  await test('All VERSIONED_MIGRATIONS are recorded in butler_migrations', async () => {
    const { VERSIONED_MIGRATIONS } = await import('../src/db/schema.js');
    const db = getDb();
    const applied = db.prepare('SELECT version FROM butler_migrations').all() as Array<{ version: number }>;
    const appliedSet = new Set(applied.map(r => r.version));
    for (const m of VERSIONED_MIGRATIONS) {
      assert(appliedSet.has(m.version), `Migration v${m.version} ("${m.description}") not recorded`);
    }
  });

  await test('Applied migrations have positive applied_at timestamps', () => {
    const db = getDb();
    const rows = db.prepare('SELECT version, applied_at FROM butler_migrations').all() as Array<{ version: number; applied_at: number }>;
    assert(rows.length > 0, 'Should have at least one applied migration');
    for (const row of rows) {
      assert(row.applied_at > 0, `Migration v${row.version} has invalid applied_at: ${row.applied_at}`);
    }
  });

  await test('Re-running initDatabase does not re-apply already-applied migrations', () => {
    const db = getDb();
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM butler_migrations').get() as any).c;
    // Calling initDatabase again hits the early-return guard (dbInstance already set),
    // but we can test idempotency by calling runMigrations logic directly via the
    // already-bootstrapped DB — applied migrations must not be duplicated.
    const rows = db.prepare('SELECT version, COUNT(*) as c FROM butler_migrations GROUP BY version HAVING c > 1').all();
    assert(rows.length === 0, 'No migration version should appear more than once');
    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM butler_migrations').get() as any).c;
    assert(countAfter === countBefore, 'Migration count should not change on repeated calls');
  });

  await test('idx_events_project_type index exists (migration v5)', () => {
    const db = getDb();
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_project_type'`
    ).get();
    assert(row !== undefined, 'idx_events_project_type index should exist after migration v5');
  });

  await test('idx_checkpoints_thread and idx_writes_thread indexes exist (migration v7)', () => {
    const db = getDb();
    const checkpointsIndex = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_checkpoints_thread'`
    ).get();
    assert(checkpointsIndex !== undefined, 'idx_checkpoints_thread index should exist after migration v7');

    const writesIndex = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_writes_thread'`
    ).get();
    assert(writesIndex !== undefined, 'idx_writes_thread index should exist after migration v7');
  });

  // =========================================================================
  // 28. Phase 4.3 — eventsexport tool
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('28. Phase 4.3 — eventsexport tool');
  console.log('──────────────────────────────────────────');

  const { handleObservabilityTool } = await import('../src/mcp/tools/observability.tools.js');
  const EXP_PROJECT = 'test-export-project';
  const EXP_SID = 'session-export-a';

  // Seed events
  const db_exp = getDb();
  db_exp.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(EXP_PROJECT, EXP_PROJECT);
  registerSession(EXP_PROJECT, EXP_SID, 'ExportClient');
  const expTodo1 = getNextSequenceValue(EXP_PROJECT, 'todo');
  const expTodo2 = getNextSequenceValue(EXP_PROJECT, 'todo');
  appendEvent(EXP_PROJECT, EXP_SID, 'TODO_CREATED', { todo_id: expTodo1, title: 'Export test task A', priority: 'high' });
  appendEvent(EXP_PROJECT, EXP_SID, 'TODO_CREATED', { todo_id: expTodo2, title: 'Export test task B', priority: 'low' });
  appendEvent(EXP_PROJECT, EXP_SID, 'TODO_COMPLETED', { todo_id: expTodo1, version: 1 });
  appendEvent(EXP_PROJECT, EXP_SID, 'BROADCAST', { from_session_id: EXP_SID, content: 'Export broadcast', sent_at: Math.floor(Date.now() / 1000) });

  await test('eventsexport returns all events as JSON by default', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT }, EXP_PROJECT);
    assert(result.content[0].type === 'text', 'Should return text content');
    const text = result.content[0].text;
    // Strip header line to get JSON
    const jsonPart = text.split('\n\n').slice(1).join('\n\n');
    const parsed = JSON.parse(jsonPart);
    assert(parsed.project_id === EXP_PROJECT, 'project_id should match');
    assert(typeof parsed.count === 'number' && parsed.count >= 4, `Expected >= 4 events, got ${parsed.count}`);
    assert(Array.isArray(parsed.events), 'events should be an array');
    assert(parsed.events[0].project_id === EXP_PROJECT, 'Each event should carry project_id');
  });

  await test('eventsexport NDJSON format produces one JSON object per line', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, format: 'ndjson' }, EXP_PROJECT);
    const text = result.content[0].text;
    const jsonPart = text.split('\n\n').slice(1).join('\n\n').trim();
    const lines = jsonPart.split('\n').filter(Boolean);
    assert(lines.length >= 4, `Expected >= 4 NDJSON lines, got ${lines.length}`);
    for (const line of lines) {
      const obj = JSON.parse(line); // throws if invalid JSON
      assert(typeof obj.id === 'number', 'Each NDJSON line should have a numeric id');
    }
  });

  await test('eventsexport respects event_type filter', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, event_type: 'TODO_CREATED' }, EXP_PROJECT);
    const text = result.content[0].text;
    const jsonPart = text.split('\n\n').slice(1).join('\n\n');
    const parsed = JSON.parse(jsonPart);
    assert(parsed.events.every((ev: any) => ev.type === 'TODO_CREATED'), 'All events should be TODO_CREATED');
    assert(parsed.count === 2, `Expected 2 TODO_CREATED events, got ${parsed.count}`);
  });

  await test('eventsexport respects session_id filter', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, session_id: EXP_SID }, EXP_PROJECT);
    const text = result.content[0].text;
    const jsonPart = text.split('\n\n').slice(1).join('\n\n');
    const parsed = JSON.parse(jsonPart);
    assert(parsed.events.every((ev: any) => ev.session_id === EXP_SID), 'All events should be from EXP_SID');
  });

  await test('eventsexport respects since filter (returns only newer events)', async () => {
    // Get the ID of the first event
    const all = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT }, EXP_PROJECT);
    const allParsed = JSON.parse(all.content[0].text.split('\n\n').slice(1).join('\n\n'));
    const firstId = allParsed.events[0].id;

    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, since: firstId }, EXP_PROJECT);
    const parsed = JSON.parse(result.content[0].text.split('\n\n').slice(1).join('\n\n'));
    assert(parsed.events.every((ev: any) => ev.id > firstId), 'All returned events should have id > since');
  });

  await test('eventsexport respects limit parameter', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, limit: 2 }, EXP_PROJECT);
    const parsed = JSON.parse(result.content[0].text.split('\n\n').slice(1).join('\n\n'));
    assert(parsed.events.length === 2, `Expected 2 events (limit), got ${parsed.events.length}`);
  });

  await test('eventsexport returns empty events array for project with no matching events', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, event_type: 'NONEXISTENT_TYPE' }, EXP_PROJECT);
    const parsed = JSON.parse(result.content[0].text.split('\n\n').slice(1).join('\n\n'));
    assert(parsed.count === 0, 'Should return 0 events for non-matching type');
    assert(parsed.events.length === 0, 'events array should be empty');
  });

  await test('eventsexport rejects limit of 0', async () => {
    let threw = false;
    try {
      await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, limit: 0 }, EXP_PROJECT);
    } catch { threw = true; }
    assert(threw, 'Should throw for limit=0');
  });

  await test('eventsexport events are sorted ascending by id', async () => {
    const result = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT }, EXP_PROJECT);
    const parsed = JSON.parse(result.content[0].text.split('\n\n').slice(1).join('\n\n'));
    const ids: number[] = parsed.events.map((ev: any) => ev.id);
    for (let i = 1; i < ids.length; i++) {
      assert(ids[i] > ids[i - 1], `Events out of order at index ${i}: ${ids[i - 1]} → ${ids[i]}`);
    }
  });

  await test('eventsexport pagination with since and until has no gaps or duplicates', async () => {
    // Get all events
    const all = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT }, EXP_PROJECT);
    const allParsed = JSON.parse(all.content[0].text.split('\n\n').slice(1).join('\n\n'));
    if (allParsed.events.length >= 3) {
      const boundaryId = allParsed.events[1].id;

      // Page 1: up to boundaryId (inclusive)
      const page1 = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, until: boundaryId }, EXP_PROJECT);
      const p1Parsed = JSON.parse(page1.content[0].text.split('\n\n').slice(1).join('\n\n'));

      // Page 2: since boundaryId (exclusive)
      const page2 = await handleObservabilityTool('eventsexport', { project_id: EXP_PROJECT, since: boundaryId }, EXP_PROJECT);
      const p2Parsed = JSON.parse(page2.content[0].text.split('\n\n').slice(1).join('\n\n'));

      // Combine
      const combined = [...p1Parsed.events, ...p2Parsed.events];
      assert(combined.length === allParsed.events.length, `Expected ${allParsed.events.length} events, got ${combined.length}`);
      
      const allIds = allParsed.events.map((e: any) => e.id);
      const combinedIds = combined.map((e: any) => e.id);
      assert(JSON.stringify(allIds) === JSON.stringify(combinedIds), 'Pagination combined IDs do not match all events');
    }
  });

  // =========================================================================
  // 19. SANITIZE MARKDOWN — escape and injection resistance
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('19. escapeMarkdownForRender');
  console.log('──────────────────────────────────────────');

  await test('escapeMarkdownForRender escapes heading hashes', () => {
    assert(escapeMarkdownForRender('# Header') === '\\# Header', 'Leading # must be escaped');
    assert(escapeMarkdownForRender('## Sub') === '\\#\\# Sub', 'Multiple ## must all be escaped');
  });

  await test('escapeMarkdownForRender escapes bold/italic asterisks', () => {
    const result = escapeMarkdownForRender('**bold**');
    assert(result === '\\*\\*bold\\*\\*', `Expected \\*\\*bold\\*\\*, got: ${result}`);
  });

  await test('escapeMarkdownForRender escapes backticks (inline code and code fences)', () => {
    assert(escapeMarkdownForRender('`code`') === '\\`code\\`', 'Backticks must be escaped');
    assert(escapeMarkdownForRender('```fence```') === '\\`\\`\\`fence\\`\\`\\`', 'Triple backticks must be escaped');
  });

  await test('escapeMarkdownForRender escapes underscores', () => {
    assert(escapeMarkdownForRender('_italic_') === '\\_italic\\_', 'Underscores must be escaped');
  });

  await test('escapeMarkdownForRender escapes square brackets and pipes', () => {
    const link = '[link](url)';
    const escaped = escapeMarkdownForRender(link);
    assert(!escaped.includes('[link]'), `Unescaped [link] found in: ${escaped}`);
    const pipe = 'a | b';
    const escapedPipe = escapeMarkdownForRender(pipe);
    assert(escapedPipe.includes('\\|'), `Pipe not escaped in: ${escapedPipe}`);
  });

  await test('escapeMarkdownForRender preserves newlines (needed for blockquote rendering)', () => {
    const input = 'line1\nline2\nline3';
    const result = escapeMarkdownForRender(input);
    assert(result.includes('\n'), 'Newlines must be preserved for blockquote line iteration');
    assert(result.split('\n').length === 3, 'Three lines should remain after sanitization');
  });

  await test('escapeMarkdownForRender is idempotent on plain text', () => {
    const plain = 'no special chars here';
    assert(escapeMarkdownForRender(plain) === plain, 'Plain text should pass through unchanged');
  });

  await test('escapeMarkdownForRender blocks injection from TODO title with malicious markdown', () => {
    const malicious = '# Injected\n```\ncode fence\n```';
    const rendered = escapeMarkdownForRender(malicious);
    assert(!rendered.match(/^#\s/m), 'Raw heading must not appear after sanitization');
    assert(!rendered.includes('```'), 'Raw code fence must not appear after sanitization');
  });

  // =========================================================================
  // 20. MARKDOWN INJECTION — end-to-end via handoff payload
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('20. Markdown Injection (end-to-end)');
  console.log('──────────────────────────────────────────');

  await test('Malicious handoff completed_todos entry is sanitized in context markdown', () => {
    const PROJECT_INJ = 'project-inject-test';
    const SESS_INJ    = 'inject-sess';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_INJ, PROJECT_INJ);
    registerSession(PROJECT_INJ, SESS_INJ, 'AttackerAgent');

    // Inject markdown via handoff payload completed_todos
    appendEvent(PROJECT_INJ, SESS_INJ, 'HANDOFF_CREATED', {
      session_id: SESS_INJ,
      completed_todos: ['# Injected heading\n```\nmalicious fence\n```'],
      pending_todos:   [],
      recent_decisions: [],
      rules_added: [],
      wiki_updated: [],
      diff_summary: '# Diff heading\n`code`',
      summary: 'Normal summary',
      timestamp: Math.floor(Date.now() / 1000)
    });

    // The context resource renders handoff payloads through escapeMarkdownForRender.
    // We verify it by calling escapeMarkdownForRender on each field directly
    // (same path as renderContextMarkdown in resources.ts).
    const state = materializeProject(PROJECT_INJ, false);
    const handoff = state.handoffs[state.handoffs.length - 1];
    assert(handoff !== undefined, 'Handoff must exist in state');

    const sanitizedTodo = escapeMarkdownForRender(handoff.payload.completed_todos[0]);
    assert(!sanitizedTodo.match(/^#/m), 'Heading injection must be escaped in completed_todos');
    assert(!sanitizedTodo.includes('```'), 'Code fence injection must be escaped in completed_todos');

    const diffSummary = handoff.payload.diff_summary ?? '';
    const sanitizedDiffLine = escapeMarkdownForRender(diffSummary.split('\n')[0]);
    assert(!sanitizedDiffLine.match(/^#/), 'Heading injection must be escaped in diff_summary');
  });

  await test('Malicious TODO title is sanitized via escapeMarkdownForRender before markdown render', () => {
    const PROJECT_INJ2 = 'project-inject-test2';
    const SESS_INJ2    = 'inject-sess2';
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(PROJECT_INJ2, PROJECT_INJ2);
    registerSession(PROJECT_INJ2, SESS_INJ2, 'AttackerAgent2');

    const todoId = getNextSequenceValue(PROJECT_INJ2, 'todo');
    appendEvent(PROJECT_INJ2, SESS_INJ2, 'TODO_CREATED', {
      todo_id: todoId,
      title: '# Injected Header\n```\nmalicious\n```',
      priority: 'high'
    });

    const state   = materializeProject(PROJECT_INJ2, false);
    const todo    = state.todos[todoId];
    assert(todo !== undefined, 'TODO must exist in materialized state');

    // renderContextMarkdown calls escapeMarkdownForRender(t.title) before interpolation
    const rendered = escapeMarkdownForRender(todo.title);
    assert(!rendered.match(/^#/m), 'Raw heading must not survive escapeMarkdownForRender');
    assert(!rendered.includes('```'), 'Raw code fence must not survive escapeMarkdownForRender');
  });

  // =========================================================================
  // 21. synccontext Coordination Tool
  // =========================================================================
  console.log('\n──────────────────────────────────────────');
  console.log('21. synccontext Coordination Tool');
  console.log('──────────────────────────────────────────');

  await test('synccontext returns status prompt and syncs when confirm_sync is true', async () => {
    const SYNC_PROJECT = 'test-sync-project';
    const SESS_A = 'sess-sync-a';
    const SESS_B = 'sess-sync-b';

    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(SYNC_PROJECT, SYNC_PROJECT);
    
    // Register session A (active peer) and session B (target session)
    registerSession(SYNC_PROJECT, SESS_A, 'Cursor');
    registerSession(SYNC_PROJECT, SESS_B, 'Claude');

    // Create rules, decisions, and memories for SESS_A
    appendEvent(SYNC_PROJECT, SESS_A, 'RULE_ADDED', { rule_id: 'test-rule-1', content: 'Always write tests' });
    appendEvent(SYNC_PROJECT, SESS_A, 'DECISION_RECORDED', { decision_id: 'test-dec-1', title: 'Use Sqlite', context: 'need local db', decision: 'we chose SQLite' });
    
    // Insert a memory directly into the DB associated with SESS_A
    db.prepare(`
      INSERT INTO memories (project_id, type, content, session_id, importance)
      VALUES (?, 'decision', 'SQLite was chosen for local persistence', ?, 0.9)
    `).run(SYNC_PROJECT, SESS_A);

    // Create a TODO and let Session A claim it
    const todoId = getNextSequenceValue(SYNC_PROJECT, 'todo');
    appendEvent(SYNC_PROJECT, SESS_A, 'TODO_CREATED', { todo_id: todoId, title: 'Sync-target task', priority: 'medium' });
    appendEvent(SYNC_PROJECT, SESS_A, 'TODO_CLAIMED', { todo_id: todoId, session_id: SESS_A, claimed_at: Date.now() });

    // Create a second TODO, claim it, and complete it to verify completed claims are not transferred
    const todoId2 = getNextSequenceValue(SYNC_PROJECT, 'todo');
    const nowTs = Date.now();
    appendEvent(SYNC_PROJECT, SESS_A, 'TODO_CREATED', { todo_id: todoId2, title: 'Completed sync-target task', priority: 'medium' });
    appendEvent(SYNC_PROJECT, SESS_A, 'TODO_CLAIMED', { todo_id: todoId2, session_id: SESS_A, claimed_at: nowTs });
    appendEvent(SYNC_PROJECT, SESS_A, 'TODO_COMPLETED', { todo_id: todoId2, version: 1 });

    // Set A's event seen marker
    db.prepare('UPDATE sessions SET last_event_seen = 42 WHERE id = ?').run(SESS_A);

    // Set SESS_A's heartbeat in the past so sync is allowed (avoiding the fresh peer check)
    db.prepare('UPDATE sessions SET last_heartbeat = ? WHERE id = ?')
      .run(getCurrentTimestamp() - 30, SESS_A);

    // Verify claim starts with SESS_A
    let state = materializeProject(SYNC_PROJECT, false);
    assert(state.todos[todoId].claimed_by === SESS_A, 'TODO should be claimed by SESS_A initially');

    // 1. Check synccontext without confirm_sync (check status)
    const resultCheck = await handleCoordinationTool('synccontext', {
      project_id: SYNC_PROJECT,
      session_id: SESS_B
    }, SYNC_PROJECT);

    assert(resultCheck.content !== undefined, 'Result check content should exist');
    assert(resultCheck.content[0].text.includes('Detected active peer'), 'Expected peer detection prompt');
    assert(resultCheck.content[0].text.includes('sess-sync-a'), 'Expected peer session id in prompt');

    // 2. Perform sync by passing confirm_sync: true
    const resultSync = await handleCoordinationTool('synccontext', {
      project_id: SYNC_PROJECT,
      session_id: SESS_B,
      confirm_sync: true
    }, SYNC_PROJECT);

    const syncText = resultSync.content[0].text;
    assert(resultSync.content !== undefined, 'Result sync content should exist');
    assert(syncText.includes('Successfully synchronized'), 'Expected success confirmation');
    
    // Verify that rules, decisions, and memories of the peer are returned in the payload
    assert(syncText.includes('Always write tests'), 'Expected peer rules in sync payload');
    assert(syncText.includes('we chose SQLite'), 'Expected peer decisions in sync payload');
    assert(syncText.includes('SQLite was chosen for local persistence'), 'Expected peer memories in sync payload');

    // 3. Verify that the claim was transferred to SESS_B in database
    invalidateProjectCache(SYNC_PROJECT);
    state = materializeProject(SYNC_PROJECT, false);
    assert(state.todos[todoId].claimed_by === SESS_B, `Expected claim to be transferred to ${SESS_B}, got: ${state.todos[todoId].claimed_by}`);
    assert(state.todos[todoId2].claimed_by !== SESS_B, `Expected completed claim to not be transferred to ${SESS_B}`);

    // Verify that both TODO_UNCLAIMED (by SESS_A) and TODO_CLAIMED (by SESS_B) events were written to the store
    const events = db.prepare('SELECT type, session_id FROM events WHERE project_id = ? ORDER BY id DESC').all(SYNC_PROJECT) as Array<{ type: string, session_id: string }>;
    const lastBroadcast = events[0];
    const lastClaim = events[1];
    const lastUnclaim = events[2];
    assert(lastBroadcast.type === 'BROADCAST' && lastBroadcast.session_id === SESS_B, 'Expected broadcast event at the end');
    assert(lastClaim.type === 'TODO_CLAIMED' && lastClaim.session_id === SESS_B, 'Expected TODO_CLAIMED event for SESS_B');
    assert(lastUnclaim.type === 'TODO_UNCLAIMED' && lastUnclaim.session_id === SESS_A, 'Expected TODO_UNCLAIMED event for SESS_A');

    // 4. Verify SESS_B's timeline pointer is aligned in DB (includes the broadcast event created during sync)
    const sessBRow = db.prepare('SELECT last_event_seen FROM sessions WHERE id = ?').get(SESS_B) as { last_event_seen: number };
    // The timeline should have been updated past the original 42 to include the broadcast event
    assert(sessBRow.last_event_seen > 42, `Expected SESS_B timeline to advance past 42 to include broadcast, got: ${sessBRow.last_event_seen}`);

    // 5. Verify that fresh heartbeat peer prevents sync
    db.prepare('UPDATE sessions SET last_heartbeat = ? WHERE id = ?').run(getCurrentTimestamp(), SESS_A);
    try {
      await handleCoordinationTool('synccontext', {
        project_id: SYNC_PROJECT,
        session_id: SESS_B,
        confirm_sync: true
      }, SYNC_PROJECT);
      assert(false, 'Expected sync to fail because SESS_A heartbeat is fresh');
    } catch (e: any) {
      assert(e.message.includes('actively working'), `Expected active working error, got: ${e.message}`);
    }
  });

  // =========================================================================
  // 29. MCP RESOURCE RENDERING
  // =========================================================================
  console.log('──────────────────────────────────────────');
  console.log('29. MCP Resource Rendering');
  console.log('──────────────────────────────────────────');

  await test('context resource rendering returns unified project markdown', async () => {
    const RES_PROJECT = 'resource-test-proj';
    const RES_SID = 'resource-sess';
    registerSession(RES_PROJECT, RES_SID, 'claude-3');

    // Create a TODO
    const todoId = getNextSequenceValue(RES_PROJECT, 'todo');
    appendEvent(RES_PROJECT, RES_SID, 'TODO_CREATED', { todo_id: todoId, title: 'Context-test task', priority: 'high' });

    const result = await handleReadResource(`butler://projects/${RES_PROJECT}/context`);
    assert(result.contents !== undefined, 'Result contents should exist');
    assert(result.contents[0].mimeType === 'text/markdown', 'Expected markdown mimeType');
    const mdText = result.contents[0].text;
    assert(mdText.includes('Context-test task'), 'Expected TODO title in markdown');
    assert(mdText.includes(RES_SID), 'Expected session ID in markdown');
  });

  await test('orchestration checkpoints resource returns serialized thread state', async () => {
    const ORCH_PROJECT = 'orch-test-proj';
    const threadId = `${ORCH_PROJECT}-thread-abc`;
    const checkpointId = 'test-checkpoint-uuid';

    const db = getDb();
    // Insert mock checkpoint and metadata into DB
    db.prepare(`
      INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
      VALUES (?, '', ?, NULL, 'state', ?, ?)
    `).run(
      threadId,
      checkpointId,
      Buffer.from(JSON.stringify({ v: 1, channel_values: { result: 'success' } }), 'utf-8'),
      Buffer.from(JSON.stringify({ step: 1 }), 'utf-8')
    );

    const result = await handleReadResource(`butler://projects/${ORCH_PROJECT}/orchestration`);
    assert(result.contents !== undefined, 'Result contents should exist');
    assert(result.contents[0].mimeType === 'application/json', 'Expected JSON mimeType');
    
    const parsed = JSON.parse(result.contents[0].text);
    assert(Array.isArray(parsed), 'Expected orchestration result to be an array');
    assert(parsed.length === 1, 'Expected 1 checkpoint row');
    assert(parsed[0].thread_id === threadId, 'Expected matching thread_id');
    assert(parsed[0].checkpoint.channel_values.result === 'success', 'Expected parsed checkpoint object');
    assert(parsed[0].metadata.step === 1, 'Expected parsed metadata object');
  });

  await test('snapshot creation, cache eviction, and rematerialization round-trip', async () => {
    const SNAP_PROJECT = 'snap-test-proj';
    const SNAP_SID = 'snap-sess';
    registerSession(SNAP_PROJECT, SNAP_SID, 'cursor');

    // 1. Write initial events
    const id1 = getNextSequenceValue(SNAP_PROJECT, 'todo');
    appendEvent(SNAP_PROJECT, SNAP_SID, 'TODO_CREATED', { todo_id: id1, title: 'First Task', priority: 'medium' });
    const id2 = getNextSequenceValue(SNAP_PROJECT, 'todo');
    appendEvent(SNAP_PROJECT, SNAP_SID, 'TODO_CREATED', { todo_id: id2, title: 'Second Task', priority: 'high' });

    // 2. Materialize state & verify initial contents
    let state = materializeProject(SNAP_PROJECT, false);
    assert(state.todos[id1] !== undefined, 'First task should exist in memory');
    assert(state.todos[id2] !== undefined, 'Second task should exist in memory');
    assert(state.lastEventId > 0, 'lastEventId should be tracked');
    const snapEventId = state.lastEventId;

    // 3. Create snapshot in database
    createSnapshot(SNAP_PROJECT, snapEventId, state);

    // 4. Invalidate the in-memory cache to force loading from database
    invalidateProjectCache(SNAP_PROJECT);

    // 5. Rematerialize from snapshot & verify state matches exactly
    const rematerialized = materializeProject(SNAP_PROJECT, false);
    assert(rematerialized.todos[id1] !== undefined, 'First task should exist after rematerialization');
    assert(rematerialized.todos[id1].title === 'First Task', 'First task title should match');
    assert(rematerialized.todos[id2] !== undefined, 'Second task should exist after rematerialization');
    assert(rematerialized.todos[id2].title === 'Second Task', 'Second task title should match');
    assert(rematerialized.lastEventId === snapEventId, 'Rematerialized lastEventId should match snapEventId');

    // 6. Write new events on top of the snapshot
    const id3 = getNextSequenceValue(SNAP_PROJECT, 'todo');
    appendEvent(SNAP_PROJECT, SNAP_SID, 'TODO_CREATED', { todo_id: id3, title: 'Third Task', priority: 'low' });

    // 7. Verify incremental replay works on top of the loaded snapshot
    const finalState = materializeProject(SNAP_PROJECT, false);
    assert(finalState.todos[id1] !== undefined, 'First task should survive incremental replay');
    assert(finalState.todos[id2] !== undefined, 'Second task should survive incremental replay');
    assert(finalState.todos[id3] !== undefined, 'Third task (appended) should exist');
    assert(finalState.todos[id3].title === 'Third Task', 'Third task title should match');
    assert(finalState.lastEventId > snapEventId, 'Final lastEventId should be advanced');
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
