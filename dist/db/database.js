import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { INIT_SCHEMA_SQL, MIGRATION_SQL } from './schema.js';
let dbInstance = null;
export function getDatabasePath(projectRoot = process.cwd()) {
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
 * Run additive schema migrations safely.
 * Each ALTER TABLE is attempted individually; errors are swallowed so the
 * function is idempotent — safe to call on every startup against any DB version.
 */
function runMigrations(db) {
    const statements = MIGRATION_SQL
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
    for (const sql of statements) {
        try {
            db.exec(sql + ';');
        }
        catch {
            // Column already exists or other benign error — skip
        }
    }
}
export function initDatabase(dbPath) {
    if (dbInstance)
        return dbInstance;
    const actualPath = dbPath || getDatabasePath();
    const dir = path.dirname(actualPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(actualPath);
    // Apply base schema (all CREATE IF NOT EXISTS — safe to re-run)
    db.exec(INIT_SCHEMA_SQL);
    // Apply additive migrations for existing databases
    runMigrations(db);
    dbInstance = db;
    return db;
}
export function getDb() {
    if (!dbInstance) {
        return initDatabase();
    }
    return dbInstance;
}
export function closeDatabase() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
    }
}
/** Compute SHA-256 hex digest of a string — used for snapshot integrity. */
export function sha256hex(data) {
    return createHash('sha256').update(data, 'utf8').digest('hex');
}
