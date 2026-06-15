import { spawnSync } from 'child_process';

console.log('Starting Butler Test Runner...');

const isWindows = process.platform === 'win32';
const cmd = isWindows ? 'npx.cmd' : 'npx';

const suites = [
  { name: 'Integration Test Suite', path: 'tests/integration.test.ts' },
  { name: 'Projections Unit Test Suite', path: 'tests/projections.test.ts' },
  { name: 'LangGraph Checkpointer Test Suite', path: 'tests/langgraph.test.ts' },
  { name: 'LangGraph Agent Orchestrator Test Suite', path: 'tests/orchestrator.test.ts' }
];

let anyFailed = false;

for (const suite of suites) {
  console.log(`\nExecuting ${suite.name}...`);
  const result = spawnSync(cmd, ['tsx', suite.path], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`❌ ${suite.name} failed with exit code ${result.status}`);
    anyFailed = true;
  } else {
    console.log(`✅ ${suite.name} passed.`);
  }
}

if (anyFailed) {
  console.error('\n❌ One or more test suites failed.');
  process.exit(1);
} else {
  console.log('\n✅ All test suites passed successfully.');
  process.exit(0);
}

