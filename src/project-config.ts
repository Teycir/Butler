import fs from 'fs';
import path from 'path';

export interface ProjectConfig {
  project_id: string;
  description?: string;
}

/**
 * Walk up the directory tree from startDir looking for .butler/project.json.
 * Returns the first valid config found, or null if none exists.
 */
export function findProjectConfig(startDir: string = process.cwd()): ProjectConfig | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const cfgPath = path.join(dir, '.butler', 'project.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (parsed.project_id && typeof parsed.project_id === 'string') {
          return { project_id: parsed.project_id, description: parsed.description };
        }
      } catch {
        // Malformed JSON — keep searching upward
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
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
