import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { INIT_SCHEMA_SQL, VERSIONED_MIGRATIONS, type Migration } from './schema.js';

let dbInstance: Database.Database | null = null;

export function getDatabasePath(projectRoot: string = process.cwd()): string {
  if (process.env.BUTLER_DB_PATH) {
    return path.resolve(projectRoot, process.env.BUTLER_DB_PATH);
  }
  const defaultDir = path.join(projectRoot, '.butler');
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

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** Compute SHA-256 hex digest of a string — used for snapshot integrity. */
export function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
