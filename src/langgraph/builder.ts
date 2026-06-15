import { StateGraph } from '@langchain/langgraph';
import { getLangGraphCheckpointer } from './checkpointer.js';
import { getDb } from '../db/database.js';
import {
  OrchestratorState,
  planningNode,
  implementationNode,
  verificationNode,
  commitNode,
  ensureOrchestratorSessions
} from './orchestrator.js';

export function buildOrchestratorGraph() {
  const checkpointer = getLangGraphCheckpointer();

  // Register orchestrator sessions once at graph compile/resume time for all existing projects
  try {
    const db = getDb();
    const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
    for (const p of projects) {
      ensureOrchestratorSessions(p.id);
    }
  } catch (e) {
    // Database might not be initialized yet in some contexts
  }

  const workflow = new StateGraph(OrchestratorState)
    .addNode('planning', planningNode)
    .addNode('implementation', implementationNode)
    .addNode('verification', verificationNode)
    .addNode('commit', commitNode);

  // Define edges and routing
  workflow.addEdge('__start__', 'planning');
  
  // Conditional router after planning check
  workflow.addConditionalEdges(
    'planning',
    (state) => {
      if (state.status === 'failed') return '__end__';
      return 'implementation';
    }
  );
  
  // Conditional router after implementation check
  workflow.addConditionalEdges(
    'implementation',
    (state) => {
      if (state.status === 'failed') return '__end__';
      if (state.todosComplete) return 'verification';
      return 'implementation';
    }
  );

  // Conditional router after verification check
  workflow.addConditionalEdges(
    'verification',
    (state) => {
      if (state.status === 'failed') return '__end__';
      if (state.testPassed) return 'commit';
      return 'implementation'; // Loop back to fix code
    }
  );

  workflow.addEdge('commit', '__end__');

  return workflow.compile({ checkpointer });
}
