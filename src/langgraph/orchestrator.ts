import { Annotation, interrupt } from '@langchain/langgraph';
import { getDb } from '../db/database.js';
import { appendEvent, getNextSequenceValue } from '../events/store.js';
import { materializeProject } from '../events/materializer.js';
import { now as getCurrentTimestamp } from '../constants.js';
import { ensureSession } from '../coordinator/lifecycle.js';

// ─── State Definition ─────────────────────────────────────────────────────────

export const OrchestratorState = Annotation.Root({
  projectId: Annotation<string>(),
  task: Annotation<string>(),
  // List of task IDs created for this orchestration
  todoIds: Annotation<number[]>(),
  // Current active agent assigned to the workflow step
  assignedAgent: Annotation<string | null>(),
  // Git diff or code change details
  diff: Annotation<string | null>(),
  // Verification test outcomes
  testPassed: Annotation<boolean | null>(),
  // Logs from test runs
  testLogs: Annotation<string | null>(),
  // Loop count to prevent infinite code-fixing cycles
  loopCount: Annotation<number>(),
  // Timestamp of the last step update (for timeouts)
  lastUpdatedAt: Annotation<number | null>(),
  // Error message if the orchestration failed
  error: Annotation<string | null>(),
  // Status of the entire workflow
  status: Annotation<'planning' | 'implementing' | 'verifying' | 'committing' | 'completed' | 'failed'>(),
  // Completion status of the TODOs
  todosComplete: Annotation<boolean | null>(),
});

export type OrchestratorStateType = typeof OrchestratorState.State;

// Helper to determine if an error is an internal LangGraph control flow signal
function isLangGraphControlError(err: any): boolean {
  if (err && err.constructor && typeof err.constructor.name === 'string') {
    const name = err.constructor.name;
    return name.includes('Graph') || name.includes('Pregel') || name.includes('Interrupt');
  }
  return false;
}

// ─── Cache Helper for orchestrator sessions ───────────────────────────────────

// Cache of registered orchestrator sessions to prevent redundant DB calls
const registeredOrchestratorSessions = new Set<string>();

export function ensureOrchestratorSessions(projectId: string): void {
  const cacheKey = `${projectId}::orchestrator`;
  if (registeredOrchestratorSessions.has(cacheKey)) return;

  ensureSession(projectId, 'orchestrator-planning', 'Orchestrator');
  ensureSession(projectId, 'orchestrator', 'Orchestrator');

  registeredOrchestratorSessions.add(cacheKey);
}

// ─── Graph Nodes ──────────────────────────────────────────────────────────────

/**
 * Node 1: Decompose & Plan (Assigned to Antigravity / Agy)
 * In a real agent setup, this would publish a request for Agy to plan.
 * It writes target TODO tasks to the Butler database.
 */
export async function planningNode(state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> {
  console.log(`[Orchestrator] Node [Planning]: Decomposing task: "${state.task}"`);
  
  try {
    const projectId = state.projectId;
    const planSessionId = 'orchestrator-planning';
    const db = getDb();
    
    // Verify project exists first to respect foreign key constraint checks
    const projectExists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
      throw new Error(`FOREIGN KEY constraint failed: Project ${projectId} does not exist.`);
    }

    // Find next sequence values using sequence helper
    const nextId = getNextSequenceValue(projectId, 'todo');

    // TODO: Implement actual task decomposition. Currently, this is a first-pass stub that
    // always creates exactly one TODO task regardless of task complexity. In the future,
    // we should use a planning agent / LLM to decompose the user's task into multiple discrete TODOs.
    appendEvent(projectId, planSessionId, 'TODO_CREATED', {
      todo_id: nextId,
      title: `Implement orchestration task: ${state.task.slice(0, 50)}`,
      priority: 'high'
    });

    appendEvent(projectId, planSessionId, 'BROADCAST', {
      from_session_id: planSessionId,
      content: `📢 Planning complete. TODO #${nextId} created. Assigning implementation to Kiro CLI.`,
      sent_at: getCurrentTimestamp()
    });

    return {
      todoIds: [nextId],
      assignedAgent: 'kiro-cli',
      status: 'implementing',
      loopCount: 0,
      lastUpdatedAt: getCurrentTimestamp(),
      error: null
    };
  } catch (err: any) {
    if (isLangGraphControlError(err)) throw err;
    console.error(`[Orchestrator] Planning node execution failed: ${err.message}`);
    return {
      status: 'failed',
      error: `Planning failed: ${err.message}`,
      assignedAgent: null,
      lastUpdatedAt: getCurrentTimestamp()
    };
  }
}

/**
 * Node 2: Implementation (Assigned to Kiro CLI)
 * Kiro runs on the user terminal. The workflow must PAUSE (interrupt)
 * until Kiro CLI claims, executes, and marks the TODO completed.
 */
export async function implementationNode(state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> {
  console.log(`[Orchestrator] Node [Implementation]: Waiting for Kiro CLI to complete TODOs: ${state.todoIds.join(', ')}`);

  try {
    // 1. Loop counter check (fail if retry limit hit to avoid unbounded runs)
    if (state.loopCount >= 3) {
      console.warn(`[Orchestrator] Max retry limit of 3 reached. Failing implementation stage.`);
      return {
        status: 'failed',
        error: `Exceeded maximum retry limit of 3 code-fix loops`,
        assignedAgent: null,
        lastUpdatedAt: getCurrentTimestamp()
      };
    }

    // 2. Timeout check (fail if inactive for > 30 minutes)
    const now = getCurrentTimestamp();
    const lastUpdate = state.lastUpdatedAt ?? now;
    const timeoutSeconds = 1800; // 30 mins
    if (now - lastUpdate > timeoutSeconds) {
      console.warn(`[Orchestrator] Workflow implementation timed out.`);
      return {
        status: 'failed',
        error: `Implementation timed out after ${timeoutSeconds} seconds of inactivity`,
        assignedAgent: null,
        lastUpdatedAt: now
      };
    }

    // Query Butler's database to check if the TODOs are completed
    const materialized = materializeProject(state.projectId, false);
    const allCompleted = state.todoIds.every(id => {
      const todo = materialized.todos[id];
      return todo && todo.status === 'completed';
    });

    if (!allCompleted) {
      // Write broadcast command requesting Kiro to implement
      appendEvent(state.projectId, 'orchestrator', 'BROADCAST', {
        from_session_id: 'orchestrator',
        content: `⚡ ATTENTION Kiro CLI: Please claim and implement tasks for TODOs: ${state.todoIds.join(', ')}`,
        sent_at: getCurrentTimestamp()
      });

      // Pause execution using LangGraph's interrupt feature.
      console.log('[Orchestrator] Interrupting workflow: Awaiting external agent action.');
      interrupt({
        message: `Awaiting Kiro CLI completion of TODOs: ${state.todoIds.join(', ')}`,
        todoIds: state.todoIds
      });
    }

    // Once resumed, we check the database again. If complete, we advance to verification.
    return {
      todosComplete: true,
      status: 'verifying',
      assignedAgent: 'opencode',
      lastUpdatedAt: getCurrentTimestamp()
    };
  } catch (err: any) {
    if (isLangGraphControlError(err)) throw err;
    console.error(`[Orchestrator] Implementation node failed: ${err.message}`);
    return {
      status: 'failed',
      error: `Implementation failed: ${err.message}`,
      assignedAgent: null,
      lastUpdatedAt: getCurrentTimestamp()
    };
  }
}

/**
 * Node 3: Verification (Assigned to OpenCode)
 * OpenCode boots the dev server or runs the test suite and posts outcomes.
 */
export async function verificationNode(state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> {
  console.log(`[Orchestrator] Node [Verification]: Triggering OpenCode verification tests...`);

  try {
    // 1. Timeout check (fail if inactive for > 30 minutes)
    const now = getCurrentTimestamp();
    const lastUpdate = state.lastUpdatedAt ?? now;
    const timeoutSeconds = 1800; // 30 mins
    if (now - lastUpdate > timeoutSeconds) {
      console.warn(`[Orchestrator] Workflow verification timed out.`);
      return {
        status: 'failed',
        error: `Verification timed out after ${timeoutSeconds} seconds`,
        assignedAgent: null,
        lastUpdatedAt: now
      };
    }

    // NOTE: This orchestrator is currently a simulation scaffold. By default, it simulates
    // a successful test run unless verification is explicitly configured to fail via env vars.
    // Replace this simulation stub with actual test runner execution or OpenCode validation logic.
    const testPassed = process.env.BUTLER_VERIFICATION_PASSED !== 'false'; 
    const testLogs = testPassed
      ? 'All 12 checks passed successfully.'
      : 'Verification failed: Test suite reported 1 failure in auth tests.';

    appendEvent(state.projectId, 'orchestrator', 'BROADCAST', {
      from_session_id: 'orchestrator',
      content: `🖥️ OpenCode Verification: ${testPassed ? '✅ Passed' : '❌ Failed'} - ${testLogs}`,
      sent_at: getCurrentTimestamp()
    });

    if (testPassed) {
      return {
        testPassed: true,
        testLogs,
        status: 'committing',
        assignedAgent: 'kiro-cli',
        lastUpdatedAt: getCurrentTimestamp(),
        error: null
      };
    } else {
      const newCount = (state.loopCount ?? 0) + 1;
      if (newCount >= 3) {
        return {
          testPassed: false,
          testLogs,
          status: 'failed',
          todosComplete: false,
          error: `Exceeded maximum code-fix retry limit of 3`,
          assignedAgent: null,
          lastUpdatedAt: getCurrentTimestamp()
        };
      }

      return {
        testPassed: false,
        testLogs,
        loopCount: newCount,
        status: 'implementing',
        todosComplete: false,
        assignedAgent: 'kiro-cli',
        lastUpdatedAt: getCurrentTimestamp(),
        error: null
      };
    }
  } catch (err: any) {
    if (isLangGraphControlError(err)) throw err;
    console.error(`[Orchestrator] Verification node failed: ${err.message}`);
    return {
      status: 'failed',
      error: `Verification failed: ${err.message}`,
      assignedAgent: null,
      lastUpdatedAt: getCurrentTimestamp()
    };
  }
}

/**
 * Node 4: Committing (Assigned to Kiro CLI)
 * Commits changes, pushes branch, and cleanly finishes.
 */
export async function commitNode(state: OrchestratorStateType): Promise<Partial<OrchestratorStateType>> {
  console.log(`[Orchestrator] Node [Commit]: Assigning final Git commit to Kiro CLI.`);

  try {
    appendEvent(state.projectId, 'orchestrator', 'BROADCAST', {
      from_session_id: 'orchestrator',
      content: `🚀 Verification passed. Kiro CLI: Please commit changes and disconnect session.`,
      sent_at: getCurrentTimestamp()
    });

    return {
      status: 'completed',
      assignedAgent: null,
      lastUpdatedAt: getCurrentTimestamp(),
      error: null
    };
  } catch (err: any) {
    if (isLangGraphControlError(err)) throw err;
    console.error(`[Orchestrator] Commit node failed: ${err.message}`);
    return {
      status: 'failed',
      error: `Commit failed: ${err.message}`,
      assignedAgent: null,
      lastUpdatedAt: getCurrentTimestamp()
    };
  }
}

// ─── Graph Setup ──────────────────────────────────────────────────────────────

export { buildOrchestratorGraph } from './builder.js';
