import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { getDb } from '../db/database.js';

let checkpointerInstance: SqliteSaver | null = null;

/**
 * Returns the global LangGraph SQLite checkpointer instance initialized
 * with Butler's native better-sqlite3 connection pool.
 */
export function getLangGraphCheckpointer(): SqliteSaver {
  if (!checkpointerInstance) {
    const db = getDb();
    checkpointerInstance = new SqliteSaver(db);
  }
  return checkpointerInstance;
}
