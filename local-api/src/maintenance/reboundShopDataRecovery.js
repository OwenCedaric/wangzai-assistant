import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRecoverySqliteSnapshot } from '../backup/recoverySqliteSnapshot.js';
import { createStableHash } from '../utils/stableHash.js';
import {
  CROSS_BORDER_COLUMNS,
  PRODUCT_SOURCE_LINK_COLUMNS,
  PURCHASE_OVERRIDE_COLUMNS,
  PURCHASE_SOURCE_LINK_COLUMNS,
  assertForeignKeyCheck,
  assertQuickCheck,
  fail,
  normalizePath,
  normalizeText,
  openReadOnlyDatabase,
} from "./reboundShopRecoveryRules.js";
export {
  DEFAULT_REBOUND_SHOP_RECOVERY_EXPECTED_COUNTS,
  ReboundShopDataRecoveryError,
} from "./reboundShopRecoveryRules.js";
import { ReboundShopDataRecoveryError } from "./reboundShopRecoveryRules.js";
import { buildRecoveryPlan, stableRowEquals, toPublicPreview } from "./reboundShopRecoveryPlan.js";

export const REBOUND_SHOP_RECOVERY_CONFIRMATION = 'RESTORE_REBOUND_SHOP_USER_DATA';

function normalizeRecoveryOptions(options = {}) {
  const sourcePath = normalizePath(options.sourcePath, 'REBOUND_RECOVERY_SOURCE_PATH_REQUIRED');
  const targetPath = normalizePath(options.targetPath, 'REBOUND_RECOVERY_TARGET_PATH_REQUIRED');
  const comparablePath = (value) => (
    process.platform === 'win32' ? value.toLowerCase() : value
  );
  const resolvedSource = existsSync(sourcePath) ? realpathSync(sourcePath) : sourcePath;
  const resolvedTarget = existsSync(targetPath) ? realpathSync(targetPath) : targetPath;
  if (comparablePath(resolvedSource) === comparablePath(resolvedTarget)) {
    fail('REBOUND_RECOVERY_SOURCE_TARGET_MUST_DIFFER');
  }
  const dataRoot = resolve(options.dataRoot || dirname(dirname(targetPath)));
  const canonicalTargetPath = resolve(join(dataRoot, 'local-api-data', 'wangzai-local-api.sqlite'));
  const canonicalProfileLockPath = resolve(join(dataRoot, 'runtime', 'profile.lock'));
  const canonicalBackupDirectory = resolve(join(dataRoot, 'backups', 'rebound-shop-data-recovery'));
  const canonicalSnapshotRoot = resolve(join(dataRoot, 'restore-staging'));
  const samePath = (left, right) => comparablePath(resolve(left)) === comparablePath(resolve(right));
  if (!samePath(targetPath, canonicalTargetPath)) fail('REBOUND_RECOVERY_TARGET_NOT_BOUND_TO_DATA_ROOT');
  if (options.profileLockPath && !samePath(options.profileLockPath, canonicalProfileLockPath)) {
    fail('REBOUND_RECOVERY_PROFILE_LOCK_OVERRIDE_PROHIBITED');
  }
  if (options.backupDirectory && !samePath(options.backupDirectory, canonicalBackupDirectory)) {
    fail('REBOUND_RECOVERY_BACKUP_DIRECTORY_OVERRIDE_PROHIBITED');
  }
  if (options.snapshotRoot && !samePath(options.snapshotRoot, canonicalSnapshotRoot)) {
    fail('REBOUND_RECOVERY_SNAPSHOT_ROOT_OVERRIDE_PROHIBITED');
  }
  return {
    ...options,
    sourcePath,
    targetPath: canonicalTargetPath,
    dataRoot,
    profileLockPath: canonicalProfileLockPath,
    backupDirectory: canonicalBackupDirectory,
    snapshotRoot: canonicalSnapshotRoot,
  };
}

export function previewReboundShopDataRecovery(options = {}) {
  const normalized = normalizeRecoveryOptions(options);
  let sourceDb = null;
  let targetDb = null;
  try {
    sourceDb = openReadOnlyDatabase(normalized.sourcePath, 'SOURCE');
    targetDb = openReadOnlyDatabase(normalized.targetPath, 'TARGET');
    const sourceQuickCheck = assertQuickCheck(sourceDb, 'SOURCE');
    const targetQuickCheck = assertQuickCheck(targetDb, 'TARGET');
    const plan = buildRecoveryPlan(sourceDb, targetDb, normalized);
    return toPublicPreview(plan, {
      profileLockPresent: existsSync(normalized.profileLockPath),
      sourceQuickCheck,
      targetQuickCheck,
    });
  } finally {
    if (sourceDb) {
      try { sourceDb.close(); } catch { /* read-only handle cleanup is best effort */ }
    }
    if (targetDb) {
      try { targetDb.close(); } catch { /* read-only handle cleanup is best effort */ }
    }
  }
}

function acquireMaintenanceProfileLock(lockPath, { now = () => new Date(), createId = randomUUID } = {}) {
  const ownerToken = createId();
  const payload = {
    maintenance: 'rebound-shop-data-recovery',
    pid: process.pid,
    ownerToken,
    acquiredAt: new Date(now()).toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('REBOUND_RECOVERY_PROFILE_LOCK_PRESENT');
    fail('REBOUND_RECOVERY_PROFILE_LOCK_ACQUIRE_FAILED');
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current?.ownerToken === ownerToken) rmSync(lockPath, { force: true });
      } catch {
        // Never remove a lock that cannot be proven to be ours.
      }
    },
  };
}

function readMainDatabasePath(db) {
  const row = db.prepare('PRAGMA database_list;').all()
    .find((entry) => normalizeText(entry.name) === 'main');
  return normalizeText(row?.file);
}

function createDurablePreRestoreBackup({
  targetDb,
  backupDirectory,
  snapshotRoot,
  now = () => new Date(),
  createId = randomUUID,
}) {
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date(now()).toISOString().replace(/[:.]/gu, '-');
  const suffix = normalizeText(createId()).replace(/[^A-Za-z0-9_-]/gu, '');
  if (!suffix) fail('REBOUND_RECOVERY_BACKUP_ID_INVALID');
  const fileName = `rebound-shop-data-before-${timestamp}-${suffix}.sqlite`;
  const finalPath = join(backupDirectory, fileName);
  const partialPath = `${finalPath}.partial`;
  if (existsSync(finalPath) || existsSync(partialPath)) fail('REBOUND_RECOVERY_BACKUP_TARGET_EXISTS');

  const snapshot = createRecoverySqliteSnapshot({ db: targetDb, snapshotRoot, createId });
  try {
    const snapshotPath = readMainDatabasePath(snapshot.db);
    if (!snapshotPath) fail('REBOUND_RECOVERY_BACKUP_SNAPSHOT_PATH_MISSING');
    copyFileSync(snapshotPath, partialPath, fsConstants.COPYFILE_EXCL);
    const backupDb = new DatabaseSync(partialPath, { readOnly: true });
    try {
      backupDb.exec('PRAGMA query_only = ON;');
      assertQuickCheck(backupDb, 'BACKUP');
    } finally {
      backupDb.close();
    }
    renameSync(partialPath, finalPath);
    return {
      path: finalPath,
      fileName: basename(finalPath),
      quickCheck: 'ok',
      method: snapshot.evidence.method,
    };
  } catch (error) {
    rmSync(partialPath, { force: true });
    if (error instanceof ReboundShopDataRecoveryError) throw error;
    fail('REBOUND_RECOVERY_BACKUP_FAILED');
  } finally {
    snapshot.dispose();
  }
}

function insertRows(db, tableName, columns, rows) {
  if (!rows.length) return 0;
  const statement = db.prepare(
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  let changed = 0;
  for (const row of rows) {
    changed += Number(statement.run(...columns.map((column) => row[column] ?? null)).changes || 0);
  }
  return changed;
}

function applyPurchaseOverridePlan(db, plan) {
  const inserted = insertRows(
    db,
    'purchase_order_overrides',
    PURCHASE_OVERRIDE_COLUMNS,
    plan.inserts,
  );
  if (!plan.rekeys.length) return { inserted, rekeyed: 0 };
  const update = db.prepare(
    `UPDATE purchase_order_overrides
     SET ${PURCHASE_OVERRIDE_COLUMNS.map((column) => `${column} = ?`).join(', ')}
     WHERE shop_id = ? AND order_key = ? AND id = ?`,
  );
  let rekeyed = 0;
  for (const { current, expected } of plan.rekeys) {
    const result = update.run(
      ...PURCHASE_OVERRIDE_COLUMNS.map((column) => expected[column] ?? null),
      current.shop_id,
      current.order_key,
      current.id,
    );
    if (Number(result.changes || 0) !== 1) {
      fail('REBOUND_RECOVERY_PURCHASE_OVERRIDE_REKEY_MISMATCH');
    }
    rekeyed += 1;
  }
  return { inserted, rekeyed };
}

function applyCrossBorderPlan(db, plan) {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  if (plan.inserts.length) {
    inserted = insertRows(db, 'cross_border_order_records', CROSS_BORDER_COLUMNS, plan.inserts);
  }
  if (plan.updates.length) {
    const updateColumns = CROSS_BORDER_COLUMNS.filter((column) => !['shop_id', 'record_key'].includes(column));
    const update = db.prepare(
      `UPDATE cross_border_order_records
       SET ${updateColumns.map((column) => `${column} = ?`).join(', ')}
       WHERE shop_id = ? AND record_key = ?`,
    );
    for (const row of plan.updates) {
      updated += Number(update.run(
        ...updateColumns.map((column) => row[column] ?? null),
        row.shop_id,
        row.record_key,
      ).changes || 0);
    }
  }
  if (plan.deleteClientRows) {
    const remove = db.prepare(
      'DELETE FROM cross_border_order_records WHERE shop_id = ? AND record_key = ?',
    );
    for (const row of plan.clientRows) {
      deleted += Number(remove.run(row.shop_id, row.record_key).changes || 0);
    }
  }
  return { inserted, updated, deleted };
}

function assertExpectedRows(db, tableName, columns, expectedRows, keyColumns) {
  const where = keyColumns.map((column) => `${column} = ?`).join(' AND ');
  const select = db.prepare(`SELECT ${columns.join(', ')} FROM ${tableName} WHERE ${where} LIMIT 2`);
  for (const expected of expectedRows) {
    const matches = select.all(...keyColumns.map((column) => expected[column]));
    if (matches.length !== 1 || !stableRowEquals(matches[0], expected, columns)) {
      fail('REBOUND_RECOVERY_READBACK_MISMATCH');
    }
  }
}

function assertReadback(db, plan) {
  assertExpectedRows(
    db,
    'purchase_order_overrides',
    PURCHASE_OVERRIDE_COLUMNS,
    plan.purchaseOverrides.expectedRows,
    ['shop_id', 'order_key'],
  );
  const purchaseOverrideCount = db.prepare(
    'SELECT COUNT(*) AS count FROM purchase_order_overrides WHERE shop_id = ?',
  ).get(plan.context.newShopId).count;
  if (Number(purchaseOverrideCount) !== plan.purchaseOverrides.expectedRows.length) {
    fail('REBOUND_RECOVERY_PURCHASE_OVERRIDE_SCOPE_COUNT_MISMATCH');
  }
  const scopedPrefix = `${plan.context.clientId}:`;
  const remainingLegacyKeys = db.prepare(
    'SELECT order_key FROM purchase_order_overrides WHERE shop_id = ?',
  ).all(plan.context.newShopId).filter((row) => !normalizeText(row.order_key).startsWith(scopedPrefix));
  if (remainingLegacyKeys.length) {
    fail('REBOUND_RECOVERY_PURCHASE_OVERRIDE_LEGACY_KEY_REMAINS');
  }
  assertExpectedRows(
    db,
    'product_source_links',
    PRODUCT_SOURCE_LINK_COLUMNS,
    plan.productSourceLinks.expectedRows,
    ['shop_id', 'product_key', 'slot_index'],
  );
  assertExpectedRows(
    db,
    'purchase_source_links',
    PURCHASE_SOURCE_LINK_COLUMNS,
    plan.purchaseSourceLinks.expectedRows,
    ['shop_id', 'order_key', 'slot_index'],
  );
  assertExpectedRows(
    db,
    'cross_border_order_records',
    CROSS_BORDER_COLUMNS,
    plan.crossBorder.expectedRows,
    ['shop_id', 'record_key'],
  );
  const remainingClientRows = db.prepare(
    'SELECT COUNT(*) AS count FROM cross_border_order_records WHERE shop_id = ?',
  ).get(plan.context.clientId).count;
  if (Number(remainingClientRows) !== 0) fail('REBOUND_RECOVERY_CLIENT_SCOPE_READBACK_MISMATCH');
  const newShopCrossBorderRows = db.prepare(
    'SELECT COUNT(*) AS count FROM cross_border_order_records WHERE shop_id = ?',
  ).get(plan.context.newShopId).count;
  if (Number(newShopCrossBorderRows) !== plan.crossBorder.expectedRows.length) {
    fail('REBOUND_RECOVERY_NEW_SCOPE_COUNT_MISMATCH');
  }
  if (db.prepare('SELECT 1 AS present FROM shops WHERE id = ? LIMIT 1').get(plan.context.oldShopId)) {
    fail('REBOUND_RECOVERY_OLD_SHOP_RESTORED_PROHIBITED');
  }
  const targetShop = db.prepare(`
    SELECT id, client_id, profile_id, external_identity_hash,
           shop_incarnation, credential_revision, status
    FROM shops WHERE id = ? LIMIT 1
  `).get(plan.context.newShopId);
  if (createStableHash(targetShop || {}) !== plan.identity.targetShopFingerprint) {
    fail('REBOUND_RECOVERY_SHOP_IDENTITY_CHANGED');
  }
}

function runRecoveryWrites(db, plan) {
  const counts = {
    purchaseOverrides: applyPurchaseOverridePlan(db, plan.purchaseOverrides),
    productSourceLinks: insertRows(
      db,
      'product_source_links',
      PRODUCT_SOURCE_LINK_COLUMNS,
      plan.productSourceLinks.inserts,
    ),
    purchaseSourceLinks: insertRows(
      db,
      'purchase_source_links',
      PURCHASE_SOURCE_LINK_COLUMNS,
      plan.purchaseSourceLinks.inserts,
    ),
    crossBorder: applyCrossBorderPlan(db, plan.crossBorder),
  };
  return counts;
}

export function applyReboundShopDataRecovery(options = {}) {
  const normalized = normalizeRecoveryOptions(options);
  if (options.confirmation !== REBOUND_SHOP_RECOVERY_CONFIRMATION) {
    fail('REBOUND_RECOVERY_CONFIRMATION_REQUIRED');
  }

  const preflight = previewReboundShopDataRecovery(normalized);
  if (!preflight.safeToApply) fail('REBOUND_RECOVERY_CONFLICT', { issues: preflight.issues });

  const maintenanceLock = acquireMaintenanceProfileLock(normalized.profileLockPath, normalized);
  let sourceDb = null;
  let targetDb = null;
  let transactionOpen = false;
  let backup = null;
  try {
    sourceDb = openReadOnlyDatabase(normalized.sourcePath, 'SOURCE');
    targetDb = new DatabaseSync(normalized.targetPath);
    targetDb.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    assertQuickCheck(sourceDb, 'SOURCE');
    assertQuickCheck(targetDb, 'TARGET');

    const lockedPreBackupPlan = buildRecoveryPlan(sourceDb, targetDb, normalized);
    if (!lockedPreBackupPlan.safeToApply) {
      fail('REBOUND_RECOVERY_CONFLICT', { issues: lockedPreBackupPlan.issues });
    }
    if (lockedPreBackupPlan.fingerprint !== preflight.previewFingerprint) {
      fail('REBOUND_RECOVERY_PREVIEW_STALE');
    }
    if (lockedPreBackupPlan.plannedWriteCount === 0) {
      return {
        ok: true,
        mode: 'apply',
        alreadyApplied: true,
        previewFingerprint: lockedPreBackupPlan.fingerprint,
        backup: null,
        counts: { plannedWrites: 0 },
      };
    }

    backup = createDurablePreRestoreBackup({
      targetDb,
      backupDirectory: normalized.backupDirectory,
      snapshotRoot: normalized.snapshotRoot,
      now: normalized.now,
      createId: normalized.createId,
    });
    normalized.testHooks?.afterBackup?.({ targetPath: normalized.targetPath });

    targetDb.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const lockedPlan = buildRecoveryPlan(sourceDb, targetDb, normalized);
    if (!lockedPlan.safeToApply) fail('REBOUND_RECOVERY_CONFLICT', { issues: lockedPlan.issues });
    if (lockedPlan.fingerprint !== lockedPreBackupPlan.fingerprint) {
      fail('REBOUND_RECOVERY_LOCKED_PREVIEW_STALE');
    }

    const writeCounts = runRecoveryWrites(targetDb, lockedPlan);
    normalized.testHooks?.afterWrites?.({ targetDb, plan: lockedPlan });
    assertReadback(targetDb, lockedPlan);
    assertQuickCheck(targetDb, 'TARGET');
    assertForeignKeyCheck(targetDb, 'TARGET');
    targetDb.exec('COMMIT;');
    transactionOpen = false;

    return {
      ok: true,
      mode: 'apply',
      alreadyApplied: false,
      previewFingerprint: lockedPlan.fingerprint,
      backup: {
        fileName: backup.fileName,
        quickCheck: backup.quickCheck,
        method: backup.method,
      },
      counts: {
        purchaseOverrides:
          writeCounts.purchaseOverrides.inserted + writeCounts.purchaseOverrides.rekeyed,
        purchaseOverridesInserted: writeCounts.purchaseOverrides.inserted,
        purchaseOverridesRekeyed: writeCounts.purchaseOverrides.rekeyed,
        purchaseOverrideLegacyKeysDeleted: writeCounts.purchaseOverrides.rekeyed,
        productSourceLinks: writeCounts.productSourceLinks,
        purchaseSourceLinks: writeCounts.purchaseSourceLinks,
        crossBorderInserted: writeCounts.crossBorder.inserted,
        crossBorderUpdated: writeCounts.crossBorder.updated,
        crossBorderClientScopeDeleted: writeCounts.crossBorder.deleted,
      },
    };
  } catch (error) {
    if (transactionOpen && targetDb) {
      try { targetDb.exec('ROLLBACK;'); } catch { /* original error wins */ }
    }
    if (error instanceof ReboundShopDataRecoveryError) throw error;
    if (normalizeText(error?.code).startsWith('TEST_')) throw error;
    fail('REBOUND_RECOVERY_APPLY_FAILED', { backupCreated: Boolean(backup) });
  } finally {
    try {
      if (sourceDb) {
        try { sourceDb.close(); } catch { /* lock release must still run */ }
      }
      if (targetDb) {
        try { targetDb.close(); } catch { /* lock release must still run */ }
      }
    } finally {
      maintenanceLock.release();
    }
  }
}
