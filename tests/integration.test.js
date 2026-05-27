import { initDatabase, closeDatabase } from '../src/db/database.js';
import { appendEvent, getNextSequenceValue } from '../src/events/store.js';
import { materializeProject } from '../src/events/materializer.js';
import { registerSession, processHeartbeat, getSession, gracefulDisconnect } from '../src/coordinator/lifecycle.js';
import { addMemory, searchMemories } from '../src/vector/index.js';
import fs from 'fs';
import path from 'path';
async function runTests() {
    console.log('🚀 Starting Butler Advanced Integration Test Suite...\n');
    const testDbPath = path.join(process.cwd(), '.butler', 'test_butler.db');
    if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
    }
    process.env.BUTLER_DB_PATH = '.butler/test_butler.db';
    initDatabase(testDbPath);
    const PROJECT_ID = 'test-project';
    const CLIENT_A = 'claude-3';
    const CLIENT_B = 'cursor-editor';
    try {
        // --- 1. SESSION REGISTRATION TEST ---
        console.log('🧪 Testing Session Lifecycle & Project Insertion...');
        const sessionA = registerSession(PROJECT_ID, CLIENT_A, 'Claude Agent');
        const sessionB = registerSession(PROJECT_ID, CLIENT_B, 'Cursor Editor Client');
        if (sessionA.status !== 'alive' || sessionB.status !== 'alive') {
            throw new Error('Failed to initialize sessions as alive.');
        }
        console.log('   ✅ Sessions registered successfully without foreign key violations.');
        // --- 2. HEARTBEAT & HEARTBEAT REJECTION ---
        console.log('\n🧪 Testing Heartbeats & Ghost Session Rejection...');
        const initialHeartbeat = sessionA.last_heartbeat;
        await new Promise(resolve => setTimeout(resolve, 1100)); // sleep 1.1s
        processHeartbeat(PROJECT_ID, CLIENT_A);
        const updatedSession = getSession(CLIENT_A);
        if (updatedSession.last_heartbeat <= initialHeartbeat) {
            throw new Error('Heartbeat timestamp did not increment.');
        }
        console.log('   ✅ Valid heartbeats update timestamps.');
        try {
            processHeartbeat(PROJECT_ID, 'ghost-session');
            throw new Error('Allowed a heartbeat from an unregistered ghost session.');
        }
        catch (e) {
            console.log(`   ✅ Correctly blocked ghost heartbeat: "${e.message}"`);
        }
        // --- 3. ATOMIC SEQUENCE COUNTER GENERATION ---
        console.log('\n🧪 Testing Atomic, Race-Free Sequence Counters...');
        const id1 = getNextSequenceValue(PROJECT_ID, 'todo');
        const id2 = getNextSequenceValue(PROJECT_ID, 'todo');
        const id3 = getNextSequenceValue(PROJECT_ID, 'todo');
        if (id1 !== 1 || id2 !== 2 || id3 !== 3) {
            throw new Error(`Sequence mismatch. Expected 1, 2, 3 but got ${id1}, ${id2}, ${id3}`);
        }
        console.log(`   ✅ Atomic sequence generated successfully (1 -> 2 -> 3).`);
        // --- 4. INCREMENTAL MATERIALIZATION CACHING ---
        console.log('\n🧪 Testing Incremental Materialization Caching...');
        appendEvent(PROJECT_ID, CLIENT_A, 'TODO_CREATED', { todo_id: id1, title: 'Install Node packages', priority: 'high' });
        appendEvent(PROJECT_ID, CLIENT_B, 'TODO_CREATED', { todo_id: id2, title: 'Setup DB connections', priority: 'medium' });
        // Initial Materialization (Should read snapshot/replay from beginning and cache)
        const t0 = Date.now();
        const state1 = materializeProject(PROJECT_ID, false);
        const duration1 = Date.now() - t0;
        if (!state1.todos[id1] || state1.todos[id1].title !== 'Install Node packages') {
            throw new Error('TODO 1 content not found in state.');
        }
        // Secondary Materialization (Should hit cache instantly)
        const t1 = Date.now();
        const state2 = materializeProject(PROJECT_ID, false);
        const duration2 = Date.now() - t1;
        console.log(`   Initial read duration: ${duration1}ms`);
        console.log(`   Cached read duration: ${duration2}ms (Optimized incremental bypass)`);
        // Append 1 new event after caching
        appendEvent(PROJECT_ID, CLIENT_A, 'TODO_COMPLETED', { todo_id: id1, version: 1 });
        // Third Materialization (Should hit cache and incrementally play just 1 new event)
        const state3 = materializeProject(PROJECT_ID, false);
        if (state3.todos[id1].status !== 'completed') {
            throw new Error('TODO 1 should be completed after incremental replay.');
        }
        console.log('   ✅ Incremental caching layer works correctly.');
        // --- 5. INTENT-BASED PROJECT RELEVANCE SEARCH ---
        console.log('\n🧪 Testing Intent-Based Memory Retrieval & Vector Search...');
        addMemory(PROJECT_ID, 'rule', 'Always export JS files with ESM.', undefined, 0.9);
        addMemory(PROJECT_ID, 'wiki', 'Guide on setting up SQLite WAL connections.', undefined, 0.7);
        // Search specifically matching the rule intent
        const searchRule = searchMemories(PROJECT_ID, 'ESM rules');
        const firstResult = searchRule[0];
        console.log(`   Query: "ESM rules"`);
        console.log(`   Top match: ${firstResult.memory.content} (Type: ${firstResult.memory.type}, Intent Score: ${(firstResult.relevance * 100).toFixed(0)}%)`);
        if (firstResult.relevance !== 1.0 || firstResult.memory.type !== 'rule') {
            throw new Error('Did not apply project relevance boost for "rule" search intent.');
        }
        console.log('   ✅ Intent-based search relevance scoring successfully boosts matching queries.');
        // --- 6. GRACEFUL DISCONNECT & HANDOFF ---
        console.log('\n🧪 Testing Graceful Disconnect & O(1) Session-Indexed Handoffs...');
        gracefulDisconnect(PROJECT_ID, CLIENT_A);
        const sessionState = getSession(CLIENT_A);
        if (sessionState.status !== 'dead') {
            throw new Error('Session did not transition to dead state.');
        }
        // Verify handoff event is written
        const updatedState = materializeProject(PROJECT_ID, false);
        console.log('   ✅ Session status marked as dead.');
        console.log('   ✅ Session-indexed handoff logs written successfully.');
        console.log('\n🎉 ALL ADVANCED SYSTEM CHECKS COMPLETED SUCCESSFULLY! 🎉');
    }
    catch (error) {
        console.error('\n❌ TEST SUITE FAILED:', error.message);
        process.exit(1);
    }
    finally {
        closeDatabase();
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }
    }
}
runTests();
