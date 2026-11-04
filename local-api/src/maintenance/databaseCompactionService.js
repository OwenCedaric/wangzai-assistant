import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

export const DATABASE_COMPACTION_CONFIRMATION = 'APPLY_DATABASE_COMPACTION';

function numberPragma(db, name) {
  return Number(db.prepare(`PRAGMA ${name}`).get()?.[name]) || 0;
}

function fileBytes(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return statSync(filePath).size;
}

function compactionFingerprint(stats) {
  const material = {
    version: 1,
    pageSize: stats.pageSize,
    pageCount: stats.pageCount,
    freePages: stats.freePages,
    schemaVersion: stats.schemaVersion,
    autoVacuumMode: stats.autoVacuumMode,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('base64url');
}

function inspectStats(db, databasePath) {
  const pageSize = numberPragma(db, 'page_size');
  const pageCount = numberPragma(db, 'page_count');
  const freePages = numberPragma(db, 'freelist_count');
  const schemaVersion = numberPragma(db, 'schema_version');
  const autoVacuumMode = numberPragma(db, 'auto_vacuum');
  const logicalBytes = pageSize * pageCount;
  const reclaimableBytes = pageSize * freePages;
  return {
    pageSize,
    pageCount,
    freePages,
    schemaVersion,
    autoVacuumMode,
    logicalBytes,
    reclaimableBytes,
    databaseBytes: fileBytes(databasePath),
    walBytes: databasePath ? fileBytes(`${databasePath}-wal`) : null,
  };
}

/**
 * Explicit physical SQLite compaction. It never decides what to delete: retention and
 * scope repair must already have made only confirmed logical changes before VACUUM runs.
 */
export function createDatabaseCompactionService(db, { databasePath = null } = {}) {
  if (!db) throw new Error('createDatabaseCompactionService requires db.');

  function inspect() {
    const sqlite = inspectStats(db, databasePath);
    return {
      ok: true,
      mode: 'read-only-compaction-preview',
      sqlite,
      recommended: sqlite.freePages > 0,
      automaticCompactionAllowed: false,
      requiredConfirmation: true,
      requiredBeforeCompaction: [
        '生成可恢复保护副本',
        '确认没有未完成的技术数据清理或数据归属修复',
        '人工确认 SQLite 物理压缩',
      ],
      previewFingerprint: compactionFingerprint(sqlite),
    };
  }

  function applyConfirmed({ confirmation, previewFingerprint, backupAcknowledged } = {}) {
    const preview = inspect();
    if (confirmation !== DATABASE_COMPACTION_CONFIRMATION || backupAcknowledged !== true) {
      return { ok: false, code: 'DATABASE_COMPACTION_CONFIRMATION_REQUIRED', preview };
    }
    if (String(previewFingerprint || '') !== preview.previewFingerprint) {
      return { ok: false, code: 'DATABASE_COMPACTION_PREVIEW_STALE', preview };
    }
    if (!preview.recommended) {
      return { ok: true, mode: 'confirmed-noop', previewFingerprint: preview.previewFingerprint, before: preview.sqlite, after: preview.sqlite };
    }

    try {
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
      if (Number(checkpoint.busy) > 0) {
        return { ok: false, code: 'DATABASE_COMPACTION_CHECKPOINT_BUSY', preview, checkpoint };
      }
      // VACUUM rebuilds SQLite pages only; it does not delete rows or alter domain data.
      // The one confirmed full rebuild also enables bounded incremental
      // reclamation for future automatic runtime-retention cycles.
      db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
      db.exec('VACUUM');
      // VACUUM itself can write a large WAL. Truncate it after the rebuilt main
      // file is durable; otherwise the UI reports a compact database while the
      // data directory still carries a second, stale-sized WAL file.
      const finalCheckpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
      const after = inspectStats(db, databasePath);
      return {
        ok: true,
        mode: 'confirmed-vacuum',
        previewFingerprint: preview.previewFingerprint,
        before: preview.sqlite,
        after,
        checkpoint,
        finalCheckpoint,
        walTruncated: Number(finalCheckpoint.busy) === 0,
        reclaimedLogicalBytes: Math.max(0, preview.sqlite.logicalBytes - after.logicalBytes),
        reclaimedDatabaseBytes: preview.sqlite.databaseBytes === null || after.databaseBytes === null
          ? null
          : Math.max(0, preview.sqlite.databaseBytes - after.databaseBytes),
      };
    } catch (error) {
      return {
        ok: false,
        code: 'DATABASE_COMPACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        preview,
      };
    }
  }

  return { inspect, applyConfirmed };
}
