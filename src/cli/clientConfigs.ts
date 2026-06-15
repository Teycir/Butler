import path from 'path';
import os from 'os';
import fs from 'fs';

export interface ClientConfig {
  slug: string;
  path: string;
}

// ─── Platform helpers ─────────────────────────────────────────────────────────

/** %APPDATA% on Windows, with safe fallback to home dir. */
function appData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/**
 * Standard per-OS config root:
 *   macOS  → ~/Library/Application Support
 *   Windows → %APPDATA%
 *   Linux  → ~/.config
 */
function configRoot(p: NodeJS.Platform): string {
  if (p === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (p === 'win32')  return appData();
  return path.join(os.homedir(), '.config');
}

// ─── Registry of all known AI pair-programming tools ─────────────────────────
// Keyed by a stable slug (used in clients.json).

export const KNOWN_CLIENTS: Record<string, (platform: NodeJS.Platform) => string> = {

  'claude-desktop': (p) =>
    path.join(configRoot(p), 'Claude', 'claude_desktop_config.json'),

  // Claude Code stores its global settings in ~/.claude/settings.json on all platforms
  'claude-code': (_) =>
    path.join(os.homedir(), '.claude', 'settings.json'),

  'cursor': (p) =>
    path.join(configRoot(p), 'Cursor', 'User', 'mcp.json'),

  'vscode': (p) =>
    path.join(configRoot(p), 'Code', 'User', 'mcp.json'),

  // Windsurf uses ~/.codeium/windsurf/mcp_config.json on all platforms
  'windsurf': (_) =>
    path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),

  'zed': (p) => {
    if (p === 'win32')  return path.join(appData(), 'Zed', 'settings.json');
    if (p === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Zed', 'settings.json');
    return path.join(os.homedir(), '.config', 'zed', 'settings.json');
  },

  // Gemini CLI: ~/.gemini/settings.json on all platforms
  'gemini-cli': (_) =>
    path.join(os.homedir(), '.gemini', 'settings.json'),

  'cline': (p) =>
    path.join(configRoot(p), 'Code', 'User',
      'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),

  'roo-code': (p) =>
    path.join(configRoot(p), 'Code', 'User',
      'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),

  'kiro-cli': (p) =>
    path.join(configRoot(p), 'kiro-cli', 'mcp.json'),

  'kilo-code': (p) =>
    path.join(configRoot(p), 'Antigravity', 'User',
      'globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'),
};

// ─── Persisted user selection ─────────────────────────────────────────────────
// Stored as an array of { slug, path } so users can register custom tools
// (unknown slugs) by providing their own config file path.

interface StoredEntry { slug: string; path: string; }

const CLIENTS_FILE = path.join(os.homedir(), '.butler', 'clients.json');

function readEntries(): StoredEntry[] {
  try {
    const raw = fs.readFileSync(CLIENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Support old format (plain string array) by upgrading on the fly
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return [];
      if (typeof parsed[0] === 'string') {
        // Old format: resolve paths now and re-save in new format
        const p = process.platform;
        const upgraded = (parsed as string[])
          .filter(slug => KNOWN_CLIENTS[slug])
          .map(slug => ({ slug, path: KNOWN_CLIENTS[slug](p) }));
        writeEntries(upgraded);
        return upgraded;
      }
      return parsed as StoredEntry[];
    }
  } catch {
    // File doesn't exist yet or is malformed — treat as empty
  }
  return [];
}

function writeEntries(entries: StoredEntry[]): void {
  fs.mkdirSync(path.dirname(CLIENTS_FILE), { recursive: true });
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(entries, null, 2));
}

/**
 * Add a client.
 * - Known slug, no path:  resolves the path from the registry.
 * - Known slug + path:    uses the provided path (override).
 * - Unknown slug + path:  registers a fully custom tool.
 * - Unknown slug, no path: error.
 */
export function addClientSlug(slug: string, customPath?: string): { ok: boolean; message: string } {
  const entries = readEntries();
  if (entries.some(e => e.slug === slug)) {
    return { ok: false, message: `"${slug}" is already registered.` };
  }
  let resolvedPath: string;
  if (customPath) {
    resolvedPath = customPath;
  } else if (KNOWN_CLIENTS[slug]) {
    resolvedPath = KNOWN_CLIENTS[slug](process.platform);
  } else {
    return { ok: false, message: `Unknown slug "${slug}". Provide a path with --path to register a custom tool, or run \`butler clients list\` to see known slugs.` };
  }
  writeEntries([...entries, { slug, path: resolvedPath }]);
  return { ok: true, message: `Added "${slug}" → ${resolvedPath}` };
}

export function removeClientSlug(slug: string): { ok: boolean; message: string } {
  const entries = readEntries();
  if (!entries.some(e => e.slug === slug)) {
    return { ok: false, message: `"${slug}" is not registered.` };
  }
  writeEntries(entries.filter(e => e.slug !== slug));
  return { ok: true, message: `Removed "${slug}".` };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns only the clients the user has explicitly registered. */
export function getClientConfigs(): ClientConfig[] {
  return readEntries().map(({ slug, path }) => ({ slug, path }));
}

/** Returns every client known to Butler (for the `list` display). */
export function getAllKnownClients(): ClientConfig[] {
  const p = process.platform;
  return Object.entries(KNOWN_CLIENTS).map(([slug, factory]) => ({
    slug,
    path: factory(p),
  }));
}

/** Returns the slugs the user has currently registered. */
export function getRegisteredSlugs(): string[] {
  return readEntries().map(e => e.slug);
}

/**
 * The deployment directory Butler installs itself into.
 * <home>/Mcp/butler-mcp — os.homedir() resolves correctly on all platforms.
 */
export function getReleaseDir(): string {
  return path.join(os.homedir(), 'Mcp', 'butler-mcp');
}
