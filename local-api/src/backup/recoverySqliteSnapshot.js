import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRecoveryExportWorkspace } from './recoveryExportWorkspace.js';

function readDatabasePath(db) {
  const row = db.prepare('PRAGMA database_list;').all()
    .find((entry) => String(entry.name || '') === 'main');
  return String(row?.file || '').trim();
}

function quoteSqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function checkpointPassive(db) {
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE);').get() || {};
    return {
      attempted: true,
      ok: Number(row.busy || 0) === 0,
      busy: Number(row.busy || 0),
      log: Number(row.log ?? -1),
      checkpointed: Number(row.checkpointed ?? -1),
      errorCode: null,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      busy: null,
      log: null,
      checkpointed: null,
      errorCode: String(error?.code || 'SQLITE_CHECKPOINT_FAILED'),
    };
  }
}

function assertQuickCheck(snapshotDb) {
  const rows = snapshotDb.prepare('PRAGMA quick_check;').all();
  const values = rows.map((row) => String(row.quick_check ?? Object.values(row)[0] ?? '').trim());
  if (values.length !== 1 || values[0].toLowerCase() !== 'ok') {
    throw new Error('RECOVERY_SNAPSHOT_QUICK_CHECK_FAILED');
  }
  const foreignKeyViolations = snapshotDb.prepare('PRAGMA foreign_key_check;').all();
  if (foreignKeyViolations.length) throw new Error('RECOVERY_SNAPSHOT_FOREIGN_KEY_CHECK_FAILED');
  return { quickCheck: 'ok', foreignKeyViolations: 0 };
}

function vacuumInto(db, snapshotPath) {
  db.exec(`VACUUM INTO ${quoteSqliteString(snapshotPath)};`);
}

/**
 * Produces one immutable SQLite recovery-export source.  VACUUM INTO owns the
 * read transaction, so committed WAL pages are included while later commits
 * cannot leak into the already-created snapshot.  Exporters must receive only
 * snapshot.db and never the active profile handle.
 */
export function createRecoverySqliteSnapshot({
  db,
  snapshotRoot,
  createId = randomUUID,
  workspaceOptions = {},
} = {}) {
  if (!db?.prepare || !db?.exec) throw new Error('RECOVERY_SNAPSHOT_DATABASE_REQUIRED');
  const sourcePath = readDatabasePath(db);
  // Keep the existing restore.sqlite family layout for account-removal
  // protection. The signed producer directory adds a restart-safe lease
  // without introducing metadata files that its strict scanner would reject.
  const controlledRoot = resolve(snapshotRoot || (
    sourcePath ? join(dirname(sourcePath), 'restore-staging') : join(tmpdir(), 'wangzai-recovery-export')
  ));
  const workspace = createRecoveryExportWorkspace({ ...workspaceOptions, root: controlledRoot, createId });
  const snapshotPath = workspace.snapshotPath;

  let snapshotDb = null;
  let fallbackDb = null;
  const checkpoint = checkpointPassive(db);
  let vacuumSource = 'active-handle';
  try {
    try {
      vacuumInto(db, snapshotPath);
    } catch (activeError) {
      // An application-owned transaction can make VACUUM illegal on the active
      // handle.  A separate connection still obtains a SQLite-consistent WAL
      // snapshot without copying the active database file family.
      if (!sourcePath) throw activeError;
      workspace.reset();
      fallbackDb = new DatabaseSync(sourcePath, { readOnly: true });
      fallbackDb.exec('PRAGMA busy_timeout = 5000;');
      vacuumSource = 'separate-read-handle';
      vacuumInto(fallbackDb, snapshotPath);
    } finally {
      if (fallbackDb) {
        try { fallbackDb.close(); fallbackDb = null; } catch { /* retain the handle until outer cleanup proves closure */ }
      }
    }
    if (fallbackDb) throw new Error('RECOVERY_SNAPSHOT_TEMP_READER_CLOSE_FAILED');

    snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    snapshotDb.exec('PRAGMA query_only = ON;');
    const integrity = assertQuickCheck(snapshotDb);
    const userVersionRow = snapshotDb.prepare('PRAGMA user_version;').get() || {};
    const userVersion = Number(userVersionRow.user_version ?? Object.values(userVersionRow)[0] ?? 0);
    let disposed = false;
    let cleanupResult = null;
    return {
      db: snapshotDb,
      evidence: Object.freeze({
        method: 'vacuum-into',
        vacuumSource,
        checkpoint,
        quickCheck: integrity.quickCheck,
        foreignKeyViolations: integrity.foreignKeyViolations,
        userVersion,
        readOnly: true,
      }),
      dispose() {
        if (disposed) return cleanupResult;
        // Do not release/rename the workspace while a DB handle might still be
        // live. A failed close remains retryable, or a later dead-PID GC handles it.
        snapshotDb.close();
        snapshotDb = null;
        cleanupResult = workspace.finish('completed');
        disposed = true;
        return cleanupResult;
      },
    };
  } catch (error) {
    let handlesClosed = true;
    if (snapshotDb) {
      try { snapshotDb.close(); snapshotDb = null; } catch { handlesClosed = false; }
    }
    if (fallbackDb) {
      try { fallbackDb.close(); fallbackDb = null; } catch { handlesClosed = false; }
    }
    if (handlesClosed) workspace.finish('failed');
    throw error;
  }
}

export function withRecoverySqliteSnapshot(options, build) {
  if (typeof build !== 'function') throw new Error('RECOVERY_SNAPSHOT_BUILD_REQUIRED');
  const snapshot = createRecoverySqliteSnapshot(options);
  try {
    return build(snapshot.db, snapshot.evidence);
  } finally {
    snapshot.dispose();
  }
}
