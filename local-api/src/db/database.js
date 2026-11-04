import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config/loadConfig.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDatabase(config = loadConfig()) {
  mkdirSync(dirname(config.database.path), { recursive: true });
  const isNewDatabase = !existsSync(config.database.path) || statSync(config.database.path).size === 0;
  const db = new DatabaseSync(config.database.path);
  // New profiles start in incremental auto-vacuum mode. Existing profiles are
  // converted by their first confirmed full compaction, after which automatic
  // maintenance can reclaim free pages in bounded slices.
  if (isNewDatabase) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(config.database.busyTimeoutMs) ? config.database.busyTimeoutMs : 5000};`);

  if (config.database.enableWal) {
    db.prepare('PRAGMA journal_mode = WAL;').get();
  }

  return db;
}

export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function listMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/u.test(fileName))
    .sort()
    .map((fileName) => ({
      fileName,
      version: fileName.replace(/\.sql$/u, ''),
      path: resolve(migrationsDir, fileName),
    }));
}

export function listAppliedMigrations(db) {
  ensureMigrationTable(db);
  return db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
}

export function runMigrations(db) {
  ensureMigrationTable(db);

  const appliedRows = listAppliedMigrations(db);
  const applied = new Set(appliedRows.map((row) => row.version));
  const appliedNow = [];

  for (const migration of listMigrationFiles()) {
    if (applied.has(migration.version)) {
      continue;
    }

    const sql = readFileSync(migration.path, 'utf8').replace(/^\uFEFF/u, '');
    db.exec('BEGIN;');
    try {
      try {
        db.exec(sql);
      } catch (error) {
        if (!/duplicate column name/iu.test(error?.message || '')) {
          throw error;
        }
        // SQLite does not support ADD COLUMN IF NOT EXISTS. 005 uses ALTER TABLE
        // for columns that may already exist in a partially upgraded local db.
        // Re-run the migration statement-by-statement and ignore only duplicate
        // column errors; all other errors still abort the migration.
        for (const statement of sql.split(';').map((item) => item.trim()).filter(Boolean)) {
          try {
            db.exec(`${statement};`);
          } catch (statementError) {
            if (!/duplicate column name/iu.test(statementError?.message || '')) {
              throw statementError;
            }
          }
        }
      }
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.fileName);
      db.exec('COMMIT;');
      appliedNow.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  return appliedNow;
}

export function getDatabaseStatus(db, config = loadConfig()) {
  const journalModeRow = db.prepare('PRAGMA journal_mode;').get();
  const userVersionRow = db.prepare('PRAGMA user_version;').get();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  return {
    ok: true,
    path: config.database.path,
    journalMode: journalModeRow?.journal_mode || 'unknown',
    userVersion: userVersionRow?.user_version ?? 0,
    tables,
  };
}

export function initializeDatabase(config = loadConfig()) {
  const db = openDatabase(config);
  const migrationsApplied = runMigrations(db);

  return {
    db,
    migrationsApplied,
    status: getDatabaseStatus(db, config),
  };
}
