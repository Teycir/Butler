#!/usr/bin/env node
/**
 * cli/main.ts
 *
 * Main entry point for the Butler CLI: `butler <command>`
 * Handles: install, status, dashboard, init, ping, doctor, and autocomplete-projects.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import readline from 'readline';
import Database from 'better-sqlite3';
import { initDatabase, getDatabasePath } from '../db/database.js';

// Resolve directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..', '..');

const HELP = `
🌐 Butler — Multi-Agent Coordination & Memory Layer CLI

Usage:
  butler <command> [options]

Commands:
  install       Configure all local AI clients (Claude Desktop, Cursor, etc.)
  init          Interactively initialize a new project config (.butler/project.json)
  status        Check the health and status of active projects
  dashboard     Run the local web dashboard served on http://localhost:7888
  ping          Diagnostics: quick ping check of Butler database & schema status
  doctor        Complete diagnostics: validate local Node, build, DB, and client configs

Options:
  --help, -h    Show this help menu
`.trim();

function askQuestion(query: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    const q = defaultValue ? `${query} [default: ${defaultValue}]: ` : `${query}: `;
    rl.question(q, answer => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function handleInstall() {
  console.log('📦 Installing Butler globally/locally...');
  
  const releaseDir = path.join(os.homedir(), 'Mcp', 'butler-mcp');
  console.log(`🚀 Deploying to ${releaseDir}...`);
  
  fs.mkdirSync(path.join(releaseDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(packageRoot, 'dist'), path.join(releaseDir, 'dist'), { recursive: true });
  fs.cpSync(path.join(packageRoot, 'package.json'), path.join(releaseDir, 'package.json'));
  
  const dbPath = path.join(os.homedir(), '.butler', 'butler.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  
  const entry = path.join(releaseDir, 'dist', 'index.js');
  
  function injectMcp(cfgPath: string, name: string, nodeBin: string, entry: string, dbPath: string) {
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) {
      console.warn(`  ⚠️  ${path.basename(dir)} not found, skipping`);
      return;
    }
    let data: any = { mcpServers: {} };
    if (fs.existsSync(cfgPath)) {
      try {
        data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (err) {
        console.error(`[Butler] Failed to parse config at ${cfgPath}, starting fresh:`, err);
      }
    }
    data.mcpServers = data.mcpServers || {};
    data.mcpServers[name] = {
      command: nodeBin,
      args: [entry],
      env: { BUTLER_DB_PATH: dbPath }
    };
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
    console.log(`  → ${cfgPath}`);
  }

  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const nodeBin = process.execPath;
  const configs: { path: string; name: string }[] = [];

  if (isMac) {
    configs.push({
      path: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    configs.push({
      path: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  } else if (isWin) {
    const appData = process.env.APPDATA || '';
    configs.push({
      path: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    configs.push({
      path: path.join(appData, 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  } else {
    // Linux
    configs.push({
      path: path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    configs.push({
      path: path.join(os.homedir(), '.config', 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  }

  configs.push({
    path: isWin
      ? path.join(process.env.APPDATA || '', 'kiro-cli', 'mcp.json')
      : path.join(os.homedir(), '.config', 'kiro-cli', 'mcp.json'),
    name: 'Kiro CLI'
  });

  configs.push({
    path: isWin
      ? path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json')
      : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json'),
    name: 'VS Code'
  });

  if (!isWin) {
    configs.push({
      path: path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'),
      name: 'Kilo Code'
    });
  }

  console.log('\n🔧 Configuring MCP clients...');
  for (const cfg of configs) {
    injectMcp(cfg.path, 'butler', nodeBin, entry, dbPath);
  }

  console.log(`\n🎉 Done! Restart your AI clients to activate Butler.\n`);
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('📋  SYSTEM PROMPT SNIPPET — paste this into your AI client once:');
  console.log('──────────────────────────────────────────────────────────────────\n');
  const snippet = 'On startup: call projectlist, then sessionregister (project_id from .butler/project.json or ask the user, session_id = "<client>-<4 random chars>", client_type = your tool name). Heartbeat every 15 seconds. Before exit: call handoffcreate with a summary of what you did, then sessiondisconnect.';
  console.log(snippet + '\n');
  
  console.log('🧪 Verifying setup...');
  console.log("Open Claude Desktop / Cursor and ask: 'Can you call the butlerping tool?'");
  console.log("Expected response: status: ok, schema_version: 8\n");
}

async function handleInit() {
  console.log('🌐 Butler — Project Setup\n');
  const defaultProjId = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const projectId = await askQuestion(`? Project ID`, defaultProjId);
  const projectName = await askQuestion(`? Project name (optional)`);
  const defaultClient = await askQuestion(`? Default client`, 'Claude Desktop');
  
  const butlerDir = path.join(process.cwd(), '.butler');
  if (!fs.existsSync(butlerDir)) {
    fs.mkdirSync(butlerDir, { recursive: true });
  }
  
  const projectJsonPath = path.join(butlerDir, 'project.json');
  fs.writeFileSync(projectJsonPath, JSON.stringify({
    project_id: projectId,
    name: projectName || undefined,
    default_client: defaultClient
  }, null, 2));
  console.log(`\n✅ Created .butler/project.json`);
  
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  }
  
  const lines = gitignoreContent.split('\n');
  const hasButler = lines.some(l => l.trim() === '.butler/' || l.trim() === '.butler');
  if (!hasButler) {
    fs.appendFileSync(gitignorePath, (gitignoreContent ? '\n' : '') + '.butler/\n');
    console.log(`✅ Added .butler/ to .gitignore`);
  } else {
    console.log(`ℹ️  .butler/ already in .gitignore`);
  }
  
  console.log(`✅ Ready! Open your AI client and start coding.`);
}

function handlePing() {
  const dbPath = getDatabasePath();
  const db = initDatabase(dbPath);
  
  let db_size_kb = 0;
  try {
    const stats = fs.statSync(dbPath);
    db_size_kb = Math.round(stats.size / 1024);
  } catch (err) {
    console.error(`[Butler] Failed to stat database file at ${dbPath}:`, err);
  }
  
  let schema_version = 0;
  try {
    const migRow = db.prepare("SELECT MAX(version) as max_v FROM butler_migrations").get() as any;
    if (migRow) schema_version = Number(migRow.max_v);
  } catch (err) {
    console.error('[Butler] Failed to query migrations table:', err);
  }
  
  let project_count = 0;
  try {
    const projRow = db.prepare("SELECT COUNT(*) as c FROM projects").get() as any;
    if (projRow) project_count = Number(projRow.c);
  } catch (err) {
    console.error('[Butler] Failed to query projects count:', err);
  }
  
  console.log(JSON.stringify({
    status: 'ok',
    db_path: dbPath,
    db_size_kb,
    schema_version,
    project_count
  }, null, 2));
  
  db.close();
}

function handleDoctor() {
  console.log('🩺 Butler Doctor Diagnostics\n');

  // Node.js version
  console.log(`✅ Node.js ${process.version} — OK`);

  // Build check
  const buildExists = fs.existsSync(path.join(packageRoot, 'dist', 'index.js'));
  if (buildExists) {
    console.log(`✅ Butler build — OK (dist/index.js exists)`);
  } else {
    console.log(`❌ Butler build — ERROR (dist/index.js is missing). Run 'npm run build' first.`);
  }

  // Database check
  const dbPath = getDatabasePath();
  const dbExists = fs.existsSync(dbPath);
  if (dbExists) {
    let schema_version = 0;
    try {
      const db = new Database(dbPath, { readonly: true });
      const migRow = db.prepare("SELECT MAX(version) as max_v FROM butler_migrations").get() as any;
      if (migRow) schema_version = Number(migRow.max_v);
      db.close();
      console.log(`✅ Database — OK (${dbPath}, schema v${schema_version})`);
    } catch (e: any) {
      console.log(`❌ Database — ERROR (${dbPath}, failed to read schema: ${e.message})`);
    }
  } else {
    console.log(`⚠️  Database — NOT FOUND (.butler/butler.db missing, will initialize on start)`);
  }

  // Check client configurations
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const clients: { name: string; path: string }[] = [];

  if (isMac) {
    clients.push({
      path: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    clients.push({
      path: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  } else if (isWin) {
    const appData = process.env.APPDATA || '';
    clients.push({
      path: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    clients.push({
      path: path.join(appData, 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  } else {
    clients.push({
      path: path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
      name: 'Claude Desktop'
    });
    clients.push({
      path: path.join(os.homedir(), '.config', 'Cursor', 'User', 'mcp.json'),
      name: 'Cursor'
    });
  }

  clients.push({
    path: isWin
      ? path.join(process.env.APPDATA || '', 'kiro-cli', 'mcp.json')
      : path.join(os.homedir(), '.config', 'kiro-cli', 'mcp.json'),
    name: 'Kiro CLI'
  });

  clients.push({
    path: isWin
      ? path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json')
      : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json'),
    name: 'VS Code'
  });

  if (!isWin) {
    clients.push({
      path: path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'),
      name: 'Kilo Code'
    });
  }

  let repairNeeded = false;
  for (const client of clients) {
    if (!fs.existsSync(client.path)) {
      console.log(`⚠️  ${client.name} config — NOT FOUND (missing file)`);
      repairNeeded = true;
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(client.path, 'utf8'));
      if (data.mcpServers && data.mcpServers.butler) {
        console.log(`✅ ${client.name} config — OK (butler entry found)`);
      } else {
        console.log(`⚠️  ${client.name} config — NOT FOUND (butler entry missing)`);
        repairNeeded = true;
      }
    } catch (err: any) {
      console.log(`❌ ${client.name} config — ERROR (invalid JSON in settings: ${err.message})`);
      repairNeeded = true;
    }
  }

  if (repairNeeded) {
    console.log(`\nFix: Run \`butler install\` to repair configuration files.`);
  }
}

function handleAutocompleteProjects() {
  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    const projects = db.prepare('SELECT id FROM projects').all() as any[];
    console.log(projects.map(p => p.id).join(' '));
  } catch (err) {
    console.error('[Butler] Failed to query projects list for autocomplete:', err);
  }
  db.close();
}

// ─── CLI Entry ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case 'install':
      await handleInstall();
      break;
    case 'init':
      await handleInit();
      break;
    case 'ping':
      handlePing();
      break;
    case 'doctor':
      handleDoctor();
      break;
    case 'autocomplete-projects':
      handleAutocompleteProjects();
      break;
    case 'status':
      // Remove command word 'status' from process.argv so status.ts receives options directly
      process.argv.splice(2, 1);
      await import('./status.js');
      break;
    case 'dashboard':
      // Remove command word 'dashboard' from process.argv so dashboard.ts receives options directly
      process.argv.splice(2, 1);
      await import('./dashboard.js');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
