import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createShopProductStorage } from './shopProductStorage.js';

function serializeError(error) {
  return {
    name: String(error?.name || 'Error'),
    code: String(error?.code || 'SHOP_PRODUCT_STORAGE_WORKER_FAILED'),
    message: String(error?.message || 'SHOP_PRODUCT_STORAGE_WORKER_FAILED'),
    tableName: error?.tableName || null,
    column: error?.column || null,
    rowIndex: Number.isFinite(Number(error?.rowIndex)) ? Number(error.rowIndex) : null,
  };
}

function requiredPath(value, field) {
  const path = String(value || '').trim();
  if (!path) {
    const error = new Error(`${field} is required`);
    error.code = `SHOP_PRODUCT_STORAGE_${field.toUpperCase()}_REQUIRED`;
    throw error;
  }
  return resolve(path);
}

function configureConnection(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 30000;');
}

function run() {
  const canonicalDatabasePath = requiredPath(workerData?.canonicalDatabasePath, 'canonical_database_path');
  const targetDatabasePath = requiredPath(workerData?.targetDatabasePath, 'target_database_path');
  if (canonicalDatabasePath === targetDatabasePath) {
    const error = new Error('canonical and shop product databases must be different');
    error.code = 'SHOP_PRODUCT_STORAGE_WORKER_PATH_COLLISION';
    throw error;
  }
  const shopId = String(workerData?.shopId || '').trim();
  const shopIncarnation = String(workerData?.shopIncarnation || '').trim();
  const canonicalDb = new DatabaseSync(canonicalDatabasePath, { readOnly: true });
  const targetDb = new DatabaseSync(targetDatabasePath);
  try {
    configureConnection(canonicalDb);
    configureConnection(targetDb);
    const route = Object.freeze({
      shopId,
      shopIncarnation,
      databasePath: targetDatabasePath,
      scopeToken: workerData?.expectedScopeToken || null,
    });
    const shopDatabaseRouter = {
      resolve() {
        const token = workerData?.expectedScopeToken;
        const current = canonicalDb.prepare('SELECT id, profile_id, shop_incarnation, credential_revision, status FROM shops WHERE id = ?').get(shopId);
        const metadata = targetDb.prepare('SELECT shop_id, profile_id, shop_incarnation FROM shop_database_metadata WHERE singleton = 1').get();
        if (!current || !metadata || current.status !== 'active'
          || metadata.shop_id !== shopId || metadata.shop_incarnation !== shopIncarnation
          || current.shop_incarnation !== shopIncarnation || current.profile_id !== metadata.profile_id
          || (token && (token.shopId !== shopId || token.profileId !== current.profile_id
            || Number(token.credentialRevision) !== Number(current.credential_revision)))) {
          const error = new Error('SHOP_PRODUCT_WORKER_SCOPE_STALE');
          error.code = 'SHOP_PRODUCT_WORKER_SCOPE_STALE';
          throw error;
        }
        return route;
      },
      open() { this.resolve(); return { route, db: targetDb, created: false, migrated: false }; },
    };
    const storage = createShopProductStorage({
      canonicalDb,
      shopDatabaseRouter,
      enabledShopIds: [shopId],
      directWriteShopIds: workerData?.directWrite ? [shopId] : [],
      mirrorWorkerRunner: null,
      manageCanonicalRevisions: false,
      backgroundRunner(task) { task(); },
    });
    return storage.mirrorShop({
      shopId,
      expectedScopeToken: workerData?.expectedScopeToken || null,
    });
  } finally {
    try { targetDb.close(); } catch { /* process exit closes the handle */ }
    try { canonicalDb.close(); } catch { /* process exit closes the handle */ }
  }
}

try {
  const result = run();
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: serializeError(error) });
}
