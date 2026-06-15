import path from 'path';
import os from 'os';
import fs from 'fs';

export interface ClientConfig {
  name: string;
  path: string;
}

// ─── Registry of all known AI pair-programming tools ─────────────────────────
// Keyed by a stable slug (used in clients.json).

export const KNOWN_CLIENTS: Record<string, (platform: NodeJS.Platform) => ClientConfig> = {
  'claude-desktop': (p) => {
    const home = os.homedir();
    if (p === 'darwin') return { name: 'Claude Desktop', path: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') };
    if (p === 'win32')  return { name: 'Claude Desktop', path: path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json') };
    return                     { name: 'Claude Desktop', path: path.join(home, '.config', 'Claude', 'claude_desktop_config.json') };
  },
  'claude-code': (_) => ({
    name: 'Claude Code',
    path: path.join(os.homedir(), '.claude', 'settings.json'),
  }),
  'cursor': (p) => {
    const home = os.homedir();
    if (p === 'darwin') return { name: 'Cursor', path: path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json') };
    if (p === 'win32')  return { name: 'Cursor', path: path.join(process.env.APPDATA || '', 'Cursor', 'User', 'mcp.json') };
    return                     { name: 'Cursor', path: path.join(home, '.config', 'Cursor', 'User', 'mcp.json') };
  },
  'vscode': (p) => {
    const home = os.homedir();
    if (p === 'darwin') return { name: 'VS Code', path: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') };
    if (p === 'win32')  return { name: 'VS Code', path: path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json') };
    return                     { name: 'VS Code', path: path.join(home, '.config', 'Code', 'User', 'mcp.json') };
  },
  'windsurf': (p) => {
    const home = os.homedir();
    const base = p === 'win32' ? (process.env.USERPROFILE || home) : home;
    return { name: 'Windsurf', path: path.join(base, '.codeium', 'windsurf', 'mcp_config.json') };
  },
  'zed': (p) => {
    const home = os.homedir();
    if (p === 'darwin') return { name: 'Zed', path: path.join(home, 'Library', 'Application Support', 'Zed', 'settings.json') };
    if (p === 'win32')  return { name: 'Zed', path: path.join(process.env.APPDATA || '', 'Zed', 'settings.json') };
    return                     { name: 'Zed', path: path.join(home, '.config', 'zed', 'settings.json') };
  },
  'gemini-cli': (_) => ({
    name: 'Gemini CLI',
    path: path.join(os.homedir(), '.gemini', 'settings.json'),
  }),
  'cline': (p) => {
    const home = os.homedir();
    const rel = path.join('globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    if (p === 'darwin') return { name: 'Cline', path: path.join(home, 'Library', 'Application Support', 'Code', 'User', rel) };
    if (p === 'win32')  return { name: 'Cline', path: path.join(process.env.APPDATA || '', 'Code', 'User', rel) };
    return                     { name: 'Cline', path: path.join(home, '.config', 'Code', 'User', rel) };
  },
  'roo-code': (p) => {
    const home = os.homedir();
    const rel = path.join('globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
    if (p === 'darwin') return { name: 'Roo Code', path: path.join(home, 'Library', 'Application Support', 'Code', 'User', rel) };
    if (p === 'win32')  return { name: 'Roo Code', path: path.join(process.env.APPDATA || '', 'Code', 'User', rel) };
    return                     { name: 'Roo Code', path: path.join(home, '.config', 'Code', 'User', rel) };
  },
  'kiro-cli': (p) => {
    const home = os.homedir();
    if (p === 'win32') return { name: 'Kiro CLI', path: path.join(process.env.APPDATA || '', 'kiro-cli', 'mcp.json') };
    return                    { name: 'Kiro CLI', path: path.join(home, '.config', 'kiro-cli', 'mcp.json') };
  },
  'kilo-code': (_) => ({
    name: 'Kilo Code',
    path: path.join(
      os.homedir(),
      '.config', 'Antigravity', 'User', 'globalStorage',
      'kilocode.kilo-code', 'settings', 'mcp_settings.json'
    ),
  }),
};

// ─── Persisted user selection ─────────────────────────────────────────────────

const CLIENTS_FILE = path.join(os.homedir(), '.butler', 'clients.json');

function readClientSlugs(): string[] {
  try {
    const raw = fs.readFileSync(CLIENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // File doesn't exist yet or is malformed — treat as empty
  }
  return [];
}

function writeClientSlugs(slugs: string[]): void {
  fs.mkdirSync(path.dirname(CLIENTS_FILE), { recursive: true });
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(slugs, null, 2));
}

export function addClientSlug(slug: string): { ok: boolean; message: string } {
  if (!KNOWN_CLIENTS[slug]) {
    return { ok: false, message: `Unknown client slug "${slug}". Run \`butler clients list\` to see available options.` };
  }
  const slugs = readClientSlugs();
  if (slugs.includes(slug)) {
    return { ok: false, message: `"${slug}" is already registered.` };
  }
  writeClientSlugs([...slugs, slug]);
  return { ok: true, message: `Added "${slug}".` };
}

export function removeClientSlug(slug: string): { ok: boolean; message: string } {
  const slugs = readClientSlugs();
  if (!slugs.includes(slug)) {
    return { ok: false, message: `"${slug}" is not registered.` };
  }
  writeClientSlugs(slugs.filter(s => s !== slug));
  return { ok: true, message: `Removed "${slug}".` };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns only the clients the user has explicitly opted in to. */
export function getClientConfigs(): ClientConfig[] {
  const slugs = readClientSlugs();
  const p = process.platform;
  return slugs
    .filter(slug => KNOWN_CLIENTS[slug])
    .map(slug => KNOWN_CLIENTS[slug](p));
}

/** Returns every client known to Butler (for display purposes). */
export function getAllKnownClients(): Array<{ slug: string } & ClientConfig> {
  const p = process.platform;
  return Object.entries(KNOWN_CLIENTS).map(([slug, factory]) => ({
    slug,
    ...factory(p),
  }));
}

/** Returns the slugs the user has currently registered. */
export function getRegisteredSlugs(): string[] {
  return readClientSlugs();
}
