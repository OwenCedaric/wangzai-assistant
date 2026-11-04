import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, runMigrations } from '../db/database.js';
import { encryptSecret } from '../security/secretCrypto.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';
import { createRecoveryReconcileState } from './recoveryReconcileState.js';
import { createRecoveryRestoreOrchestrator } from './recoveryRestoreOrchestrator.js';

function assertDatabaseConfig(config) {
  const databasePath = String(config?.database?.path || '').trim();
  if (!databasePath) throw new Error('RECOVERY_STAGING_DATABASE_PATH_REQUIRED');
  return resolve(databasePath);
}

function assertIntegrity(db) {
  const integrity = db.prepare('PRAGMA integrity_check;').all().map((row) => Object.values(row)[0]);
  if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('RECOVERY_STAGING_INTEGRITY_CHECK_FAILED');
  if (db.prepare('PRAGMA foreign_key_check;').all().length) throw new Error('RECOVERY_STAGING_FOREIGN_KEY_CHECK_FAILED');
}

function checkpointAndClose(db) {
  try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').all(); } catch { /* WAL may be disabled */ }
  db.close();
}

/** Builds and verifies a closed SQLite restore candidate; it never touches the active database. */
export function createRecoveryStagingService({
  config,
  randomUuid = randomUUID,
  encryptShopSecret = encryptSecret,
  hasPendingAccountRemoval = () => false,
} = {}) {
  const activeDatabasePath = assertDatabaseConfig(config);
  if (typeof hasPendingAccountRemoval !== 'function') {
    throw new Error('RECOVERY_STAGING_PENDING_ACCOUNT_REMOVAL_CHECK_REQUIRED');
  }
  const stagingRoot = join(dirname(activeDatabasePath), 'restore-staging');
  let accountRemovalFenced = false;
  let activeStages = 0;

  function pendingAccountRemoval() {
    try {
      return hasPendingAccountRemoval() === true;
    } catch {
      throw new Error('RECOVERY_STAGING_ACCOUNT_REMOVAL_STATE_UNAVAILABLE');
    }
  }

  function getAccountRemovalStatus() {
    return { fenced: accountRemovalFenced || pendingAccountRemoval(), active: activeStages };
  }

  function assertAccountRemovalAdmission() {
    if (getAccountRemovalStatus().fenced) throw new Error('RECOVERY_STAGING_ACCOUNT_REMOVAL_QUIESCED');
  }

  async function quiesceAccountRemoval(_owner, { timeoutMs = 30_000 } = {}) {
    accountRemovalFenced = true;
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
    while (activeStages > 0) {
      if (Date.now() >= deadline) throw new Error('RECOVERY_STAGING_ACCOUNT_REMOVAL_DRAIN_TIMEOUT');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    return { ok: true, ...getAccountRemovalStatus() };
  }

  function releaseAccountRemovalFence() {
    const released = accountRemovalFenced;
    accountRemovalFenced = false;
    return { ok: true, released, ...getAccountRemovalStatus() };
  }

  async function stageRemoteGeneration({ remoteClient, generationId, passphrase } = {}) {
    return stageRemoteGenerations({ remoteClient, generationIds: [generationId], passphrase });
  }

  async function stageRemoteGenerations({ remoteClient, generationIds, passphrase } = {}) {
    assertAccountRemovalAdmission();
    activeStages += 1;
    const restoreId = String(randomUuid()).trim();
    try {
      if (!restoreId) throw new Error('RECOVERY_STAGING_RESTORE_ID_REQUIRED');
      const restoreDirectory = join(stagingRoot, restoreId);
      const stagingDatabasePath = join(restoreDirectory, 'restore.sqlite');
      if (existsSync(stagingDatabasePath)) throw new Error('RECOVERY_STAGING_PATH_COLLISION');
      mkdirSync(restoreDirectory, { recursive: true });
      const stagingConfig = {
        ...config,
        database: { ...config.database, path: stagingDatabasePath },
      };
      let db;
      try {
        db = openDatabase(stagingConfig);
        const migrationsApplied = runMigrations(db);
        const keysetStore = createRecoveryKeysetStore({ db });
        const result = await createRecoveryRestoreOrchestrator({
          keysetStore,
          encryptShopSecret,
          targetProfileId: String(config?.runtime?.profileId || '').trim() || 'default',
        }).stageRemoteGenerations({ remoteClient, generationIds, passphrase, stagingDb: db });
        assertIntegrity(db);
        const reconcileState = createRecoveryReconcileState({ db });
        const reconciles = result.shops.map((shop, index) => reconcileState.prepare({
          restoreId,
          generationId: result.generationIds[index],
          shopId: shop.shopId,
        }));
        checkpointAndClose(db);
        db = null;
        return {
          ok: true,
          restoreId,
          generationId: result.generationId,
          generationIds: result.generationIds,
          requestedGenerationIds: result.requestedGenerationIds,
          mode: 'staging-ready',
          stagingDatabasePath,
          migrationsApplied,
          profile: result.profile,
          shop: result.shop,
          shops: result.shops,
          reconcile: reconciles[0],
          reconciles,
        };
      } catch (error) {
        if (db) {
          try { checkpointAndClose(db); } catch { /* preserve quarantined staging for diagnosis */ }
        }
        throw error;
      }
    } finally {
      activeStages = Math.max(0, activeStages - 1);
    }
  }

  return {
    activeDatabasePath,
    getAccountRemovalStatus,
    quiesceAccountRemoval,
    releaseAccountRemovalFence,
    stageRemoteGeneration,
    stageRemoteGenerations,
    stagingRoot,
  };
}
