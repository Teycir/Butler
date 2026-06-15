import fs from 'fs';
import path from 'path';

export interface ProjectConfig {
  project_id: string;
  description?: string;
}

function normalizeFolderName(dir: string): string {
  const base = path.basename(dir);
  if (!base || base === '/' || base === '.' || base === '..') {
    return 'default-project';
  }
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'default-project';
}

/**
 * Walk up the directory tree from startDir looking for .butler/project.json.
 * If none is found, automatically creates one in startDir and returns it.
 */
export function findProjectConfig(startDir: string = process.cwd()): ProjectConfig {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  // 1. Search upward
  while (true) {
    const cfgPath = path.join(dir, '.butler', 'project.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (parsed.project_id && typeof parsed.project_id === 'string') {
          return { project_id: parsed.project_id, description: parsed.description };
        }
      } catch (err) {
        console.error(`[Butler] Malformed project config at ${cfgPath}:`, err);
        // keep searching upward
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  // 2. If not found, auto-create in startDir
  const projectId = normalizeFolderName(startDir);
  const butlerDir = path.join(startDir, '.butler');
  const cfgPath = path.join(butlerDir, 'project.json');
  const newConfig: ProjectConfig = {
    project_id: projectId,
    description: 'Auto-generated project configuration by Butler'
  };

  try {
    if (!fs.existsSync(butlerDir)) {
      fs.mkdirSync(butlerDir, { recursive: true });
    }
    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf8');
    console.log(`[Butler] Auto-created project configuration at ${cfgPath} with project_id "${projectId}"`);
  } catch (err) {
    console.warn(`[Butler] Failed to write project configuration to ${cfgPath} (read-only filesystem?):`, err);
  }

  return newConfig;
}

// Cached at module load time so every tool call in a server instance
// sees the same default project, even if cwd changes.
let _cached: ProjectConfig | null | undefined = undefined;

export function getDefaultProjectConfig(): ProjectConfig | null {
  if (_cached === undefined) {
    _cached = findProjectConfig();
  }
  return _cached;
}

export function getDefaultProjectId(): string | null {
  return getDefaultProjectConfig()?.project_id ?? null;
}

/** Invalidate the module-level cache (used in tests). */
export function resetProjectConfigCache(): void {
  _cached = undefined;
}
