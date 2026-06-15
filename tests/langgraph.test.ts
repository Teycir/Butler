import { initDatabase, getDb } from '../src/db/database.js';
import { getLangGraphCheckpointer } from '../src/langgraph/checkpointer.js';
import { StateGraph, Annotation } from '@langchain/langgraph';
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
  console.log('🚀 Butler LangGraph Checkpointer Test Suite\n');

  const testDbPath = path.join(process.cwd(), '.butler', 'test_langgraph.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.BUTLER_DB_PATH = '.butler/test_langgraph.db';
  initDatabase(testDbPath);

  await test('Initializes SqliteSaver checkpointer and tables', async () => {
    const checkpointer = getLangGraphCheckpointer();
    assert(checkpointer !== null, 'Checkpointer should not be null');

    // Run setup to ensure tables are created (using bracket notation for protected method in tests)
    await checkpointer['setup']();

    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('checkpoints', 'writes')"
    ).all() as Array<{ name: string }>;
    
    assert(tables.length === 2, `Expected 2 tables (checkpoints, writes), got: ${tables.length}`);
  });

  await test('Saves state checkpoints during graph execution', async () => {
    const checkpointer = getLangGraphCheckpointer();

    // Define simple state
    const GraphState = Annotation.Root({
      count: Annotation<number>(),
    });

    // Node function
    const increment = (state: typeof GraphState.State) => {
      return { count: (state.count ?? 0) + 1 };
    };

    // Build simple graph
    const workflow = new StateGraph(GraphState)
      .addNode('increment', increment)
      .addEdge('__start__', 'increment')
      .addEdge('increment', '__end__');

    const app = workflow.compile({ checkpointer });

    const config = { configurable: { thread_id: 'test-thread' } };
    
    // Execute graph
    const result = await app.invoke({ count: 5 }, config);
    assert(result.count === 6, `Expected count 6, got ${result.count}`);

    // Check if checkpoints were saved in the SQLite db
    const db = getDb();
    const checkpointRows = db.prepare('SELECT thread_id, checkpoint_id FROM checkpoints WHERE thread_id = ?').all('test-thread');
    assert(checkpointRows.length > 0, 'No checkpoints saved in the database');
    
    const latestTuple = await checkpointer.getTuple(config);
    assert(latestTuple !== undefined, 'Should be able to retrieve latest checkpoint tuple');
    if (!latestTuple) {
      throw new Error('latestTuple is undefined');
    }
    assert(latestTuple.checkpoint.channel_values.count === 6, `Expected count 6, got ${latestTuple.checkpoint.channel_values.count}`);
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
