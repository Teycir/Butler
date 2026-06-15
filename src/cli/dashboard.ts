/**
 * cli/dashboard.ts
 *
 * Local web dashboard served on http://localhost:7888.
 * CLI runner script that boots the server and handles system signals.
 */

import fs from 'fs';
import path from 'path';
import { initDatabase } from '../db/database.js';
import { createServer, startPolling } from './dashboardServer.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface DashboardArgs {
  readonly port: number;
  readonly host: string;
  readonly db?: string;
  readonly dev: boolean;
}

function parseArgs(argv: string[]): DashboardArgs {
  const args = { port: 7888, host: '127.0.0.1', db: undefined as string | undefined, dev: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') args.port = Number(argv[++i]);
    if (argv[i] === '--host') args.host = argv[++i];
    if (argv[i] === '--db') args.db = argv[++i];
    if (argv[i] === '--dev') args.dev = true;
  }
  return args;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = args.db
    ? path.resolve(process.cwd(), args.db)
    : path.join(process.cwd(), '.butler', 'butler.db');

  if (!fs.existsSync(dbPath) && !args.dev) {
    console.warn(`⚠️  Database not found: ${dbPath}`);
    console.warn(`   Dashboard will start but show "No projects" until the DB is created.`);
  }

  if (args.dev) {
    initDatabase(dbPath);
  }

  const server = createServer(dbPath, args.dev);
  startPolling(dbPath, args.dev);

  server.listen(args.port, args.host, () => {
    console.log(`\n🤵  Butler Dashboard`);
    console.log(`    URL:      http://${args.host}:${args.port}`);
    console.log(`    Database: ${dbPath}`);
    console.log(`    Mode:     ${args.dev ? 'dev-writable' : 'read-only'}`);
    console.log(`    Updates:  every 5s via SSE\n`);
    console.log(`    Press Ctrl+C to stop.\n`);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down dashboard…');
    server.close();
    process.exit(0);
  });
}

main();
