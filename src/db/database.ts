import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { INIT_SCHEMA_SQL } from './schema.js';

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

export function initDatabase(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;

  const actualPath = dbPath || getDatabasePath();
  const dir = path.dirname(actualPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(actualPath);
  
  // Apply our schema & pragmas
  db.exec(INIT_SCHEMA_SQL);
  
  // Set busy timeout to prevent SQLITE_BUSY under parallel writes
  db.pragma('busy_timeout = 5000');
  
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
