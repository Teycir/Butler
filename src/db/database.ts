import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { INIT_SCHEMA_SQL, VERSIONED_MIGRATIONS, type Migration } from './schema.js';

let dbInstance: Database.Database | null = null;

/**
 * Butler's DB is one shared SQLite file holding every project's data
 * (keyed by project_id — see the `projects` table), never one DB per
 * repo. It must therefore live OUTSIDE any repo Butler is used in, or
 * every project working directory ends up with its own stray
 * .butler/butler.db that has to be gitignored by hand. `~/.butler/`
 * is the single canonical home for it, matching what `butler install`
 * (cli/main.ts's handleInstall) already computes and injects as
 * BUTLER_DB_PATH into every registered AI client config.
 *
 * `projectRoot` is no longer used to build the default path (fixed
 * 2026-08-23: it previously defaulted to `${projectRoot}/.butler/`,
 * i.e. process.cwd() when called with no argument — which put a real,
 * growing SQLite DB inside whatever repo Butler happened to be
 * launched from whenever BUTLER_DB_PATH wasn't set, e.g. a client
 * config predating the env-var wiring, a stale/ad hoc `npx` invocation,
 * or `butler ping`/`butler doctor` run directly inside a repo). The
 * parameter is kept, defaulted to process.cwd(), only so
 * findProjectConfig-style callers/tests that still pass it don't break
 * — it is intentionally ignored for path construction now.
 */
export function getDatabasePath(_projectRoot: string = process.cwd()): string {
  if (process.env.BUTLER_DB_PATH) {
    // An explicit override is always honored verbatim (resolved against
    // cwd only if given as a relative path — matches path.resolve's own
    // behavior: an absolute BUTLER_DB_PATH passes through unchanged).
    return path.resolve(process.env.BUTLER_DB_PATH);
  }
  const defaultDir = path.join(os.homedir(), '.butler');
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  return path.join(defaultDir, 'butler.db');
}

/**
 * Versioned migration runner — the single migration system for Butler.
 *
 * On startup:
 *   1. Bootstraps the butler_migrations tracking table if it doesn't exist yet.
 *   2. Reads which versions have already been applied.
 *   3. Applies pending migrations in version order, each inside a transaction.
 *      On failure the transaction rolls back and an error is thrown with the
 *      migration version and description so operators know exactly what failed.
 *
 * Each migration is applied exactly once and never re-applied.
 * New schema changes go in VERSIONED_MIGRATIONS in schema.ts — not here.
 */
function runMigrations(db: Database.Database): void {
  // Bootstrap the tracking table first (idempotent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS butler_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);

  const applied = new Set<number>(
    (db.prepare('SELECT version FROM butler_migrations').all() as Array<{ version: number }>)
      .map(r => r.version)
  );

  const pending = VERSIONED_MIGRATIONS
    .filter(m => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction((m: Migration) => {
      for (const sql of m.up) {
        try {
          db.exec(sql);
        } catch (err: any) {
          // ALTER TABLE on an already-existing column is benign — skip it.
          // Any other error is real and must propagate to abort the transaction.
          if (/duplicate column/i.test(err.message)) continue;
          throw err;
        }
      }
      db.prepare('INSERT INTO butler_migrations (version, description) VALUES (?, ?)')
        .run(m.version, m.description);
    });

    try {
      apply(migration);
      console.error(`[Butler] Migration v${migration.version} applied: ${migration.description}`);
    } catch (err: any) {
      throw new Error(
        `[Butler] Migration v${migration.version} ("${migration.description}") failed: ${err.message}. ` +
        `Fix the schema manually or contact the Butler maintainers.`
      );
    }
  }
}

export function initDatabase(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;

  const actualPath = dbPath || getDatabasePath();
  const dir = path.dirname(actualPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(actualPath);

  // Apply base schema (all CREATE IF NOT EXISTS — safe to re-run)
  db.exec(INIT_SCHEMA_SQL);

  // Apply versioned migrations
  runMigrations(db);

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

const closeCallbacks: (() => void)[] = [];

export function registerCloseCallback(cb: () => void): void {
  closeCallbacks.push(cb);
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  for (const cb of closeCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('[Butler] Error executing database close callback:', err);
    }
  }
}

/** Compute SHA-256 hex digest of a string — used for snapshot integrity. */
export function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
