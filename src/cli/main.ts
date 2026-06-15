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
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase, getDatabasePath } from '../db/database.js';
import {
  getClientConfigs,
  getAllKnownClients,
  addClientSlug,
  removeClientSlug,
  getReleaseDir,
} from './clientConfigs.js';

// Resolve directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..', '..');

const HELP = `
🌐 Butler — Multi-Agent Coordination & Memory Layer CLI

Usage:
  butler <command> [options]

Commands:
  clients       Manage which AI tools Butler installs into
                  butler clients list            — show all available + registered clients
                  butler clients add <slug>      — opt in to a client
                  butler clients remove <slug>   — opt out of a client
  install       Inject Butler MCP into every registered client
  init          Interactively initialize a new project config (.butler/project.json)
  status        Check the health and status of active projects
  tui           Interactive live terminal monitor dashboard
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

function handleClients(subArgs: string[]) {
  const sub = subArgs[0];

  if (!sub || sub === 'list') {
    const registered = new Map(getClientConfigs().map(c => [c.slug, c.path]));
    const all = getAllKnownClients();
    const knownSlugs = new Set(all.map(c => c.slug));

    console.log('\n📋 Known AI clients\n');
    for (const { slug } of all) {
      const tick = registered.has(slug) ? '✅' : '  ';
      console.log(`  ${tick}  ${slug}`);
      if (registered.has(slug)) {
        console.log(`           ${registered.get(slug)}`);
      }
    }

    // Show any custom (unknown slug) entries the user added
    const customEntries = getClientConfigs().filter(c => !knownSlugs.has(c.slug));
    if (customEntries.length > 0) {
      console.log('\n  Custom entries:');
      for (const { slug, path: entryPath } of customEntries) {
        console.log(`  ✅  ${slug}`);
        console.log(`           ${entryPath}`);
      }
    }

    if (registered.size === 0) {
      console.log('\n  No clients registered yet.');
      console.log('  Run: butler clients add <slug>');
      console.log('  Or:  butler clients add <my-tool> --path /path/to/mcp.json\n');
    } else {
      console.log(`\n  ${registered.size} client(s) registered. Run \`butler install\` to apply.\n`);
    }
    return;
  }

  if (sub === 'add') {
    const slug = subArgs[1];
    if (!slug) {
      console.error('Usage: butler clients add <slug> [--path /path/to/config.json]');
      console.error('Run `butler clients list` to see known slugs.');
      process.exit(1);
    }
    // Parse optional --path flag
    const pathFlagIdx = subArgs.indexOf('--path');
    const customPath = pathFlagIdx !== -1 ? subArgs[pathFlagIdx + 1] : undefined;

    const result = addClientSlug(slug, customPath);
    console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
    if (result.ok) {
      console.log(`   Run \`butler install\` to inject Butler.`);
    }
    return;
  }

  if (sub === 'remove') {
    const slug = subArgs[1];
    if (!slug) {
      console.error('Usage: butler clients remove <slug>');
      process.exit(1);
    }
    const result = removeClientSlug(slug);
    console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
    return;
  }

  console.error(`Unknown subcommand: clients ${sub}`);
  console.error('Available: list | add <slug> [--path /path/to/config] | remove <slug>');
  process.exit(1);
}

async function handleInstall() {
  const releaseDir = getReleaseDir();
  const mcpDir = path.dirname(releaseDir);

  // ── Step 0: Ensure deployment directory exists ─────────────────────────────
  if (!fs.existsSync(mcpDir)) {
    console.log(`📁 Creating ${mcpDir}...`);
    fs.mkdirSync(mcpDir, { recursive: true });
  }
  fs.mkdirSync(releaseDir, { recursive: true });

  // ── Step 1: Build ──────────────────────────────────────────────────────────
  console.log('🔨 Building from source...');
  try {
    // On Windows, npm is a .cmd script so we must use the shell
    const isWin = process.platform === 'win32';
    execSync('npm run build', {
      cwd: packageRoot,
      stdio: 'inherit',
      shell: isWin ? 'cmd.exe' : '/bin/sh',
    });
  } catch (err) {
    console.error('\n❌ Build failed. Fix TypeScript errors above and retry.');
    process.exit(1);
  }

  // ── Step 2: Sync dist/ to deployment dir ──────────────────────────────────
  console.log(`\n🚀 Syncing to ${releaseDir}...`);

  // Wipe the old dist so deleted files don't linger
  const releaseDist = path.join(releaseDir, 'dist');
  if (fs.existsSync(releaseDist)) {
    fs.rmSync(releaseDist, { recursive: true, force: true });
  }
  fs.mkdirSync(releaseDist, { recursive: true });

  // Copy fresh build artefacts
  fs.cpSync(path.join(packageRoot, 'dist'), releaseDist, { recursive: true });
  fs.cpSync(path.join(packageRoot, 'package.json'), path.join(releaseDir, 'package.json'));
  fs.cpSync(path.join(packageRoot, 'tsconfig.json'), path.join(releaseDir, 'tsconfig.json'));

  console.log('  ✅ dist/ synced');

  // ── Step 3: Ensure DB dir exists ──────────────────────────────────────────
  const dbPath = path.join(os.homedir(), '.butler', 'butler.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const entry = path.join(releaseDir, 'dist', 'index.js');
  const nodeBin = process.execPath;

  // ── Step 4: Inject into registered AI clients ─────────────────────────────
  const configs = getClientConfigs();

  if (configs.length === 0) {
    console.log('\n⚠️  No AI clients registered yet.');
    console.log('   Add one first, e.g.:  butler clients add claude-desktop');
    console.log('   See all options with: butler clients list\n');
    return;
  }

  function injectMcp(cfgPath: string, name: string, nodeBin: string, entry: string, dbPath: string) {
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) {
      console.warn(`  ⚠️  Directory not found, skipping: ${dir}`);
      return;
    }
    let data: any = { mcpServers: {} };
    if (fs.existsSync(cfgPath)) {
      try {
        data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (err) {
        console.error(`  ⚠️  Failed to parse ${cfgPath}, starting fresh:`, err);
      }
    }
    data.mcpServers = data.mcpServers || {};
    data.mcpServers[name] = {
      command: nodeBin,
      args: [entry],
      env: { BUTLER_DB_PATH: dbPath }
    };
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
    console.log(`  ✅ ${cfgPath}`);
  }

  console.log('\n🔧 Injecting Butler into registered AI clients...');
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
  console.log("Open any registered client and ask: 'Can you call the butlerping tool?'");
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

  // Build check (source)
  const srcBuildExists = fs.existsSync(path.join(packageRoot, 'dist', 'index.js'));
  if (srcBuildExists) {
    console.log(`✅ Source build    — OK (${packageRoot}/dist/index.js)`);
  } else {
    console.log(`❌ Source build    — MISSING. Run \`npm run build\` in ${packageRoot}`);
  }

  // Deployment sync check
  const releaseDir = getReleaseDir();
  const deployedEntry = path.join(releaseDir, 'dist', 'index.js');
  const deployedCliMain = path.join(releaseDir, 'dist', 'cli', 'main.js');
  const sourceCliMain   = path.join(packageRoot, 'dist', 'cli', 'main.js');
  if (!fs.existsSync(deployedEntry)) {
    console.log(`❌ Deployment      — MISSING (${deployedEntry}). Run \`butler install\`.`);
  } else {
    // Compare mtime of key file to detect stale deployment
    const srcMtime    = fs.existsSync(sourceCliMain)   ? fs.statSync(sourceCliMain).mtimeMs   : 0;
    const deployMtime = fs.existsSync(deployedCliMain) ? fs.statSync(deployedCliMain).mtimeMs : 0;
    if (srcMtime > deployMtime + 1000) {
      console.log(`⚠️  Deployment     — STALE (source is newer). Run \`butler install\` to sync.`);
    } else {
      console.log(`✅ Deployment      — UP TO DATE (${releaseDir})`);
    }
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
  const clients = getClientConfigs();

  let repairNeeded = false;
  for (const client of clients) {
    if (!fs.existsSync(client.path)) {
      console.log(`⚠️  ${client.slug} — config NOT FOUND`);
      repairNeeded = true;
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(client.path, 'utf8'));
      if (data.mcpServers && data.mcpServers.butler) {
        console.log(`✅ ${client.slug} — OK`);
      } else {
        console.log(`⚠️  ${client.slug} — butler entry missing`);
        repairNeeded = true;
      }
    } catch (err: any) {
      console.log(`❌ ${client.slug} — invalid JSON (${err.message})`);
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
    case 'clients':
      handleClients(args.slice(1));
      break;
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
    case 'tui':
      // Remove command word 'tui' from process.argv so tui.ts receives options directly
      process.argv.splice(2, 1);
      await import('./tui.js');
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
